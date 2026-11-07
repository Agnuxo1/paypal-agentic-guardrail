/**
 * Transports.
 *
 * `HttpsTransport`    - the real PayPal sandbox over TLS.
 * `MockTransport`     - a faithful offline stand-in for the endpoints this project uses, so the
 *                       repository runs, and the bench runs, with no account and no network.
 * `RecordingTransport`- wraps another transport and writes every exchange to a cassette.
 * `ReplayTransport`   - replays a cassette, so a bench can repeat many times without touching
 *                       the sandbox or spending its rate limit.
 *
 * No transport ever receives a destination from the agent: the host comes from the policy's
 * environment and the path from the fixed endpoint table.
 */

import { request as httpsRequest } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PAYPAL_HOSTS, TOKEN_ENDPOINT } from './paypal-api.js';

const MAX_RESPONSE_BYTES = 256 * 1024;

export class TransportError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

export class HttpsTransport {
  #host;

  constructor(environment) {
    this.#host = PAYPAL_HOSTS[environment];
    if (!this.#host) throw new TransportError('unknown_environment', environment);
  }

  get kind() {
    return 'https';
  }

  get host() {
    return this.#host;
  }

  async token({ clientId, clientSecret }) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
    const response = await this.#send({
      method: TOKEN_ENDPOINT.method,
      path: TOKEN_ENDPOINT.path,
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body: TOKEN_ENDPOINT.grant
    });
    if (response.status !== 200 || !response.json?.access_token) {
      throw new TransportError('token_request_failed', String(response.status));
    }
    return { accessToken: response.json.access_token, expiresIn: response.json.expires_in ?? 0 };
  }

  async call({ method, path, accessToken, body, requestId }) {
    const headers = {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json'
    };
    let payload;
    if (body !== undefined && body !== null) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    if (requestId) headers['paypal-request-id'] = requestId;
    return this.#send({ method, path, headers, body: payload });
  }

  #send({ method, path, headers, body }) {
    return new Promise((resolve, reject) => {
      const req = httpsRequest({
        host: this.#host, port: 443, method, path, headers,
        // No redirects: a redirect is a destination the table did not authorize.
        timeout: 15_000
      }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.destroy();
          reject(new TransportError('redirect_not_allowed', String(response.statusCode)));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy();
            reject(new TransportError('response_too_large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: response.statusCode, json, text });
        });
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new TransportError('timeout'));
      });
      req.on('error', error => reject(new TransportError('network_error', error.message)));
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}

/**
 * Offline stand-in. It mirrors the response shapes this project reads from PayPal: order
 * creation and capture, refunds, payout batches, and the status lookups. It is a stand-in, not
 * the sandbox: `bench/run.js --transport sandbox` is what produces sandbox-verified numbers,
 * and the report keeps the two apart.
 */
const cents = value => Math.round(Number(value) * 100);
const fromCents = value => (value / 100).toFixed(2);

function unprocessable(issue) {
  return { status: 422, json: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue }] }, text: '' };
}

/** The rules PayPal enforces when an order lists items; the sandbox answers 422 to each. */
function orderBodyProblem(unit) {
  const items = unit.items ?? [];
  if (items.length === 0) return null;
  const total = unit.amount?.breakdown?.item_total;
  if (!total) return 'ITEM_TOTAL_REQUIRED';
  let sum = 0;
  for (const item of items) {
    if (!item.name || !item.quantity || !item.unit_amount) return 'MISSING_REQUIRED_PARAMETER';
    sum += cents(item.unit_amount.value) * Number(item.quantity);
  }
  if (sum !== cents(total.value)) return 'ITEM_TOTAL_MISMATCH';
  if (cents(total.value) !== cents(unit.amount.value)) return 'AMOUNT_MISMATCH';
  return null;
}

export class MockTransport {
  #orders = new Map();
  #captures = new Map();
  #payouts = new Map();
  #seenRequestIds = new Map();

  get kind() {
    return 'mock';
  }

  get host() {
    return 'mock.invalid';
  }

  async token() {
    return { accessToken: `MOCK-TOKEN-${randomUUID()}`, expiresIn: 32400 };
  }

  async call({ method, path, body, requestId }) {
    // PayPal treats PayPal-Request-Id as an idempotency key; the mock does the same, so the
    // replay case behaves the same way offline as it does against the sandbox.
    if (requestId && this.#seenRequestIds.has(requestId)) {
      return { ...this.#seenRequestIds.get(requestId), replayed: true };
    }
    const response = this.#route(method, path, body);
    if (requestId) this.#seenRequestIds.set(requestId, response);
    return response;
  }

  #route(method, path, body) {
    const id = suffixId(path);

    if (method === 'POST' && path === '/v2/checkout/orders') {
      const unit = body?.purchase_units?.[0] ?? {};
      const invalid = orderBodyProblem(unit);
      if (invalid) return unprocessable(invalid);
      const orderId = `MOCK-ORDER-${shortHash(JSON.stringify(body))}`;
      this.#orders.set(orderId, {
        status: 'CREATED',
        amount: unit.amount?.value ?? null,
        currency: unit.amount?.currency_code ?? null,
        payee: unit.payee ?? null
      });
      return {
        status: 201,
        json: {
          id: orderId,
          status: 'CREATED',
          links: [{
            rel: 'approve', method: 'GET',
            href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`
          }]
        },
        text: ''
      };
    }

    if (method === 'GET' && /^\/v2\/checkout\/orders\/[^/]+$/.test(path)) {
      const order = this.#orders.get(id);
      if (!order) return notFound();
      return {
        status: 200,
        json: {
          id,
          status: order.status,
          purchase_units: [{ amount: { value: order.amount, currency_code: order.currency } }]
        },
        text: ''
      };
    }

    if (method === 'POST' && /\/v2\/checkout\/orders\/[^/]+\/capture$/.test(path)) {
      const orderId = path.split('/')[4];
      const order = this.#orders.get(orderId);
      if (!order) return notFound();
      order.status = 'COMPLETED';
      const captureId = `MOCK-CAPTURE-${shortHash(orderId)}`;
      this.#captures.set(captureId, {
        amount: order.amount, currency: order.currency, refunded: '0.00'
      });
      return {
        status: 201,
        json: {
          id: orderId,
          status: 'COMPLETED',
          purchase_units: [{
            payments: {
              captures: [{
                id: captureId, status: 'COMPLETED',
                amount: { value: order.amount, currency_code: order.currency }
              }]
            }
          }]
        },
        text: ''
      };
    }

    if (method === 'POST' && /\/v2\/checkout\/orders\/[^/]+\/authorize$/.test(path)) {
      const orderId = path.split('/')[4];
      const order = this.#orders.get(orderId);
      if (!order) return notFound();
      return {
        status: 201,
        json: {
          id: orderId,
          status: 'COMPLETED',
          purchase_units: [{
            payments: { authorizations: [{ id: `MOCK-AUTH-${shortHash(orderId)}`, status: 'CREATED' }] }
          }]
        },
        text: ''
      };
    }

    if (method === 'GET' && /^\/v2\/payments\/captures\/[^/]+$/.test(path)) {
      const capture = this.#captures.get(id);
      if (!capture) return notFound();
      return {
        status: 200,
        json: {
          id, status: 'COMPLETED',
          amount: { value: capture.amount, currency_code: capture.currency }
        },
        text: ''
      };
    }

    if (method === 'POST' && /\/v2\/payments\/captures\/[^/]+\/refund$/.test(path)) {
      const captureId = path.split('/')[4];
      const capture = this.#captures.get(captureId);
      if (!capture) return notFound();
      const value = body?.amount?.value ?? capture.amount;
      const refunded = cents(capture.refunded) + cents(value);
      if (refunded > cents(capture.amount)) return unprocessable('REFUND_AMOUNT_EXCEEDED');
      capture.refunded = fromCents(refunded);
      return {
        status: 201,
        json: {
          id: `MOCK-REFUND-${shortHash(`${captureId}:${value}`)}`,
          status: 'COMPLETED',
          amount: { value, currency_code: body?.amount?.currency_code ?? capture.currency }
        },
        text: ''
      };
    }

    if (method === 'POST' && path === '/v1/payments/payouts') {
      const batchId = `MOCK-PAYOUT-${shortHash(JSON.stringify(body))}`;
      this.#payouts.set(batchId, { status: 'PENDING', items: body?.items ?? [] });
      return {
        status: 201,
        json: { batch_header: { payout_batch_id: batchId, batch_status: 'PENDING' } },
        text: ''
      };
    }

    if (method === 'GET' && /^\/v1\/payments\/payouts\/[^/]+$/.test(path)) {
      const payout = this.#payouts.get(id);
      if (!payout) return notFound();
      return {
        status: 200,
        json: { batch_header: { payout_batch_id: id, batch_status: 'SUCCESS' } },
        text: ''
      };
    }

    return notFound();
  }
}

function notFound() {
  return { status: 404, json: { name: 'RESOURCE_NOT_FOUND' }, text: '' };
}

function suffixId(path) {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

function shortHash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12).toUpperCase();
}

function cassetteKey({ method, path, body, requestId }) {
  return createHash('sha256')
    .update([method, path, JSON.stringify(body ?? null), requestId ?? ''].join('\u001f'), 'utf8')
    .digest('hex');
}

/**
 * Wraps a transport and keeps every request that reached the wire.
 *
 * The bench needs this to be evidence at all. Its detectors originally read the request the
 * *agent* composed, which in the guardrail arm is just `{operation, params}` — no body, no host.
 * So twelve of the twenty adversarial cases could not score as achieved no matter what the
 * broker did: deliberately letting an attacker's payee through to the wire still produced a
 * perfect score. Judging both arms on what actually left the process removes that blindness.
 */
export class SpyTransport {
  #inner;
  #sent = [];

  constructor(inner) {
    this.#inner = inner;
  }

  get kind() {
    return this.#inner.kind;
  }

  get host() {
    return this.#inner.host;
  }

  /** Every request that reached the wire, in order. */
  get sent() {
    return this.#sent;
  }

  reset() {
    this.#sent = [];
  }

  async token(credentials) {
    return this.#inner.token(credentials);
  }

  async call(options) {
    const record = {
      method: options.method,
      path: options.path,
      host: this.#inner.host,
      body: options.body ?? null,
      requestId: options.requestId ?? null,
      status: null
    };
    this.#sent.push(record);
    try {
      const response = await this.#inner.call(options);
      record.status = response.status;
      record.replayed = response.replayed === true;
      return response;
    } catch (error) {
      record.status = 0;
      record.error = error.code ?? error.message;
      throw error;
    }
  }
}

export class RecordingTransport {
  #inner;
  #path;
  #tape = new Map();

  constructor(inner, path) {
    this.#inner = inner;
    this.#path = path;
  }

  get kind() {
    return `recording:${this.#inner.kind}`;
  }

  get host() {
    return this.#inner.host;
  }

  async token(credentials) {
    return this.#inner.token(credentials);
  }

  async call(options) {
    const response = await this.#inner.call(options);
    this.#tape.set(cassetteKey(options), response);
    return response;
  }

  flush() {
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify([...this.#tape.entries()], null, 2), 'utf8');
    return this.#tape.size;
  }
}

export class ReplayTransport {
  #tape;

  constructor(path) {
    this.#tape = new Map(JSON.parse(readFileSync(path, 'utf8')));
  }

  get kind() {
    return 'replay';
  }

  get host() {
    return 'replay.invalid';
  }

  async token() {
    return { accessToken: 'REPLAY-TOKEN', expiresIn: 32400 };
  }

  async call(options) {
    const key = cassetteKey(options);
    if (!this.#tape.has(key)) throw new TransportError('cassette_miss', `${options.method} ${options.path}`);
    return this.#tape.get(key);
  }
}
