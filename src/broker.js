// SPDX-FileCopyrightText: 2026 Francisco Angulo de Lafuente
// SPDX-License-Identifier: MIT
// Research-Project: PayPal Agentic Guardrail
// Research-Author: Francisco Angulo de Lafuente
// Research-ORCID: https://orcid.org/0009-0001-1634-7063
// Research-Date: 2026-11-07
/**
 * The Payment Operation Broker — the new component this project contributes.
 *
 * EnigmAgent v3 already brokers *fixed read operations*: the agent names an operation, the
 * broker attaches the credential and returns only `{operation, status, ok}`, discarding the
 * upstream body. That broker accepts `GET` and `HEAD` only
 * (`platforms/mcp-server/operation-broker.js`, method allow-list), so it cannot create an
 * order, capture it, refund it or send a payout — every PayPal write is a `POST`.
 *
 * This broker extends the same principle to the write path, which is where the money is:
 *
 *   1. the agent may name only an operation the operator declared;
 *   2. its parameters are validated against a closed schema, and an undeclared parameter is
 *      rejected rather than ignored;
 *   3. the operator's bound fields (payee, currency, intent, destination) are applied last, so
 *      an agent value can never survive on a bound path;
 *   4. spending limits are evaluated against the hash-chained ledger before the call;
 *   5. the idempotency key is derived in the broker, so a replayed instruction cannot produce
 *      a second charge;
 *   6. a reference (`order_id`, `capture_id`) must be one the broker itself issued earlier;
 *   7. the response is reduced to the fields the operator listed, and asserted free of
 *      credential material before it is returned.
 *
 * Nothing here trusts the model. The agent's only degrees of freedom are an operation name and
 * values inside operator-declared ranges.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { compareDecimal, composeBody, PolicyError, validateParameters } from './policy.js';
import { checkLimits } from './ledger.js';
import { REFERENCE_PATHS, readPath } from './paypal-api.js';
import { assertNoCredential } from './credentials.js';

/** Refusals that are ordinary policy outcomes rather than security incidents. */
const PLAIN_REFUSALS = new Set([
  'operation_not_allowed', 'parameters_not_object', 'parameter_missing', 'parameter_not_decimal',
  'parameter_below_min', 'parameter_above_max', 'parameter_out_of_range', 'parameter_not_in_enum',
  'parameter_text_invalid', 'parameter_text_forbidden_content', 'reference_required',
  'reference_unknown', 'limit_per_call_exceeded', 'limit_daily_total_exceeded',
  'limit_rate_exceeded', 'pending_approval', 'upstream_error', 'credentials_unavailable'
]);

/**
 * Which refusal codes mean the agent tried to reach past its boundary. These are recorded as
 * attempts; they are incidents only in the sense that the attempt happened, and the ledger
 * distinguishes an *attempt* from a *success*. The bench counts successes as incidents and
 * attempts as blocked attacks.
 */
const BOUNDARY_ATTEMPTS = Object.freeze({
  parameter_not_allowed: 'bound_override_attempt',
  // A top-level field the interface does not define — a `url`, a `host`, a `payee` — is the
  // same reach past the boundary, and the operator should see it in the ledger as one.
  request_field_not_allowed: 'bound_override_attempt'
});

export class BrokerResult {
  constructor(fields) {
    Object.assign(this, fields);
    Object.freeze(this);
  }
}

/**
 * Fixed text that tells a model how to correct an honest mistake. Without it, smaller models
 * repeated the same malformed call until they ran out of rounds. Hints are constants: nothing
 * from the request or the policy is echoed, so they reveal no bound value.
 */
const REFUSAL_HINTS = Object.freeze({
  parameter_not_decimal: 'Send the amount as a string with two decimals, for example "49.00".',
  parameter_missing: 'A required parameter is missing. Call list_payment_operations for the exact parameters.',
  parameter_not_allowed: 'That parameter does not exist on this operation. Call list_payment_operations for the exact parameters.',
  operation_not_allowed: 'That operation is not available. Call list_payment_operations for the operations you may run.',
  reference_required: 'This operation needs the id returned by an earlier call, passed as `reference`.'
});

const CAPTURED_AMOUNT_PATH = ['purchase_units', 0, 'payments', 'captures', 0, 'amount', 'value'];

/**
 * PayPal's own state of an order or a payout batch. `status` in a result is the broker's verdict
 * on the call, so without this a status lookup could only ever answer "executed", and one model
 * read that as "already captured" and stopped. Only an upper-case token gets through: this field
 * is the upstream's text, and free text must not reach the model.
 */
function paypalStatus(json) {
  const value = json?.status ?? json?.batch_header?.batch_status ?? null;
  return typeof value === 'string' && /^[A-Z_]{1,32}$/.test(value) ? value : null;
}

/**
 * The link a buyer opens to approve an order; PayPal will not capture an order until they have.
 * This is the one upstream value passed back whole, so it is only accepted on PayPal's own hosts:
 * anything else becomes `null`, and the agent can never be handed a look-alike to give a buyer.
 */
function payerApprovalLink(json) {
  const links = Array.isArray(json?.links) ? json.links : [];
  const link = links.find(entry => entry?.rel === 'payer-action' || entry?.rel === 'approve');
  try {
    const url = new URL(link?.href ?? '');
    const onPayPal = /^(www\.)?(sandbox\.)?paypal\.com$/.test(url.hostname);
    return url.protocol === 'https:' && onPayPal ? url.href : null;
  } catch {
    return null;
  }
}

export class PaymentOperationBroker {
  #policy;
  #transport;
  #credentials;
  #ledger;
  #approvals;
  #tokenCache = null;
  #clock;
  /** Tail of the serialisation chain; see `execute`. */
  #queue = Promise.resolve();

  constructor({ policy, transport, credentials, ledger, approvals, clock = () => Date.now() }) {
    this.#policy = policy;
    this.#transport = transport;
    this.#credentials = credentials;
    this.#ledger = ledger;
    this.#approvals = approvals ?? new ApprovalQueue();
    this.#clock = clock;
  }

  get ledger() {
    return this.#ledger;
  }

  get approvals() {
    return this.#approvals;
  }

  /** What the agent is allowed to know: names, bounded shapes, never bound values. */
  catalogue() {
    return this.#policy.catalogue;
  }

  /**
   * The single entry point an agent has. `request` is `{ operation, params, reference }`.
   *
   * Requests are serialised. Limits are read from the ledger and the ledger is written after an
   * `await`, so two concurrent calls could each see the same remaining budget and both spend it.
   * An MCP client can pipeline calls freely, so that is not a theoretical race: forty parallel
   * calls spent five times a daily cap before this was added.
   */
  async execute(request) {
    const previous = this.#queue;
    let release;
    this.#queue = new Promise(resolvePromise => { release = resolvePromise; });
    try {
      await previous;
      return await this.#ledger.exclusive(() => this.#executeSerial(request));
    } catch (error) {
      if (error.code === 'ledger_busy') return new BrokerResult({ ok: false, status: 'ledger_busy' });
      throw error;
    } finally {
      release();
    }
  }

  async #executeSerial(request) {
    const operationName = typeof request?.operation === 'string' ? request.operation : '';
    const operation = this.#policy.operations.get(operationName);
    if (!operation) {
      return this.#refuse({ operation: operationName || '(none)', api: '' }, 'operation_not_allowed');
    }

    // A field the interface does not define is refused, not ignored. Ignoring it would hide the
    // attempt: an injection that produced `url` or `payee` at the top level would leave no trace
    // in the ledger, and the operator would never learn the agent had been talked into trying.
    const unknownFields = Object.keys(request ?? {})
      .filter(key => !['operation', 'params', 'reference'].includes(key));
    if (unknownFields.length > 0) {
      return this.#refuse(operation, 'request_field_not_allowed', unknownFields.join(','));
    }

    let values;
    try {
      values = validateParameters(operation, request.params ?? {});
    } catch (error) {
      if (error instanceof PolicyError) {
        // PolicyError.message already begins with the code; keep only the field detail.
        const detail = error.message.startsWith(`${error.code}: `)
          ? error.message.slice(error.code.length + 2)
          : error.message;
        return this.#refuse(operation, error.code, detail);
      }
      throw error;
    }

    // A reference must be one this broker issued; the agent cannot point at an arbitrary id.
    let reference = null;
    if (operation.endpoint.reference) {
      reference = typeof request.reference === 'string' ? request.reference : null;
      if (!reference) return this.#refuse(operation, 'reference_required');
      if (!this.#ledger.knownReference(operation.endpoint.reference, reference)) {
        return this.#refuse(operation, 'reference_unknown');
      }
    }

    const amount = operation.amountFieldName ? values[operation.amountFieldName] : null;

    const limitRefusal = checkLimits(operation, amount, this.#ledger, this.#clock()) ??
      this.#refundRefusal(operation, reference, amount);
    if (limitRefusal) {
      return this.#refuse(operation, limitRefusal.code, limitRefusal.detail, { amount });
    }

    if (this.#requiresApproval(operation, amount)) {
      const ticket = this.#approvals.enqueue({ operation: operation.name, params: values, reference, amount });
      this.#record({
        operation: operation.name, api: operation.api, outcome: 'pending_approval',
        amount, detail: ticket.id
      });
      return new BrokerResult({ ok: false, status: 'pending_approval', approval_id: ticket.id });
    }

    return this.#dispatch(operation, values, reference, amount);
  }

  /**
   * Execute a request a human operator approved in the console.
   *
   * The limits are checked again here, against the ledger as it is now. A ticket was within
   * budget when it was queued, but several tickets can be queued while each is individually
   * fine and then approved together — eight approved refunds once totalled twice their daily
   * cap. The operator approved *this payment*, not an exemption from their own limits.
   *
   * The ticket is only consumed once the attempt has been made and did not fail in transit, so
   * a timeout does not silently destroy an approval the operator has already given.
   */
  async executeApproved(approvalId) {
    const previous = this.#queue;
    let release;
    this.#queue = new Promise(resolvePromise => { release = resolvePromise; });
    try {
      await previous;
      return await this.#ledger.exclusive(() => this.#executeApprovedSerial(approvalId));
    } catch (error) {
      if (error.code === 'ledger_busy') return new BrokerResult({ ok: false, status: 'ledger_busy' });
      throw error;
    } finally {
      release();
    }
  }

  async #executeApprovedSerial(approvalId) {
    {
      const ticket = this.#approvals.peek(approvalId);
      if (!ticket) return new BrokerResult({ ok: false, status: 'approval_not_found' });
      const operation = this.#policy.operations.get(ticket.operation);
      if (!operation) {
        this.#approvals.take(approvalId);
        return new BrokerResult({ ok: false, status: 'operation_not_allowed' });
      }

      const limitRefusal = checkLimits(operation, ticket.amount, this.#ledger, this.#clock()) ??
        this.#refundRefusal(operation, ticket.reference, ticket.amount);
      if (limitRefusal) {
        this.#approvals.take(approvalId);
        return this.#refuse(operation, limitRefusal.code, limitRefusal.detail, { amount: ticket.amount });
      }

      const result = await this.#dispatch(
        operation, ticket.params, ticket.reference, ticket.amount, true
      );
      // Keep the ticket only if the attempt never reached a decision, so the operator can retry.
      if (result.status !== 'transport_error') this.#approvals.take(approvalId);
      return result;
    }
  }

  /**
   * A refund may not exceed what is left of its capture. The limits above cap the operator's
   * exposure per call and per day; this caps it per payment, so an agent cannot return 240.00
   * on a 49.00 sale just because 240.00 is inside the range.
   */
  #refundRefusal(operation, reference, amount) {
    if (operation.api !== 'payments_v2.refund' || amount === null) return null;
    const remaining = this.#ledger.refundableOnCapture(reference);
    if (remaining === null) return { code: 'capture_amount_unknown', detail: reference };
    if (compareDecimal(amount, remaining) > 0) {
      return { code: 'refund_exceeds_capture', detail: `${amount} > ${remaining}` };
    }
    return null;
  }

  #requiresApproval(operation, amount) {
    if (operation.approval === 'always') return true;
    if (operation.approval === 'none') return false;
    const threshold = operation.approval.slice('over_amount:'.length);
    if (amount === null) return false;
    // compareDecimal is re-imported lazily to keep this module's imports flat.
    const [ai, af] = amount.split('.');
    const [ti, tf] = threshold.split('.');
    return BigInt(ai) * 100n + BigInt(af) > BigInt(ti) * 100n + BigInt(tf);
  }

  async #dispatch(operation, values, reference, amount, approved = false) {
    const path = operation.endpoint.reference
      ? operation.endpoint.path.replace('{id}', encodeURIComponent(reference))
      : operation.endpoint.path;

    // Idempotency is derived here, from the operation and the normalised request, never taken
    // from the agent. A repeated instruction inside the same window maps to the same key, and
    // PayPal (and the mock) then return the first result instead of charging twice.
    //
    // It is derived from the body *before* derived fields are filled in, because one of those
    // fields is the key itself: PayPal's Payouts API wants it in the body as `sender_batch_id`.
    const baseBody = operation.endpoint.method === 'GET' ? null : composeBody(operation, values);
    const requestId = operation.endpoint.writes
      ? this.#deriveRequestId(operation, baseBody, reference)
      : null;
    const body = operation.endpoint.method === 'GET'
      ? null
      : composeBody(operation, values, { request_id: requestId });
    if (requestId && this.#ledger.hasRequestId(requestId)) {
      this.#record({
        operation: operation.name, api: operation.api, outcome: 'replay_suppressed',
        amount, request_id: requestId
      });
      return new BrokerResult({ ok: false, status: 'replay_suppressed' });
    }

    let credential;
    try {
      credential = await this.#credentials.resolve();
    } catch (error) {
      return this.#refuse(operation, 'credentials_unavailable', error.code ?? error.message);
    }

    let accessToken;
    try {
      accessToken = await this.#accessToken(credential);
    } catch (error) {
      return this.#refuse(operation, 'credentials_unavailable', error.code ?? error.message);
    }

    let response;
    try {
      response = await this.#transport.call({
        method: operation.endpoint.method, path, accessToken, body, requestId
      });
    } catch (error) {
      // A redirect is recorded as a destination incident: the table did not authorize it.
      const outcome = error.code === 'redirect_not_allowed' ? 'destination_not_in_table' : 'transport_error';
      this.#record({
        operation: operation.name, api: operation.api, outcome, amount,
        detail: error.code ?? 'unknown', request_id: requestId
      });
      return new BrokerResult({ ok: false, status: outcome });
    }

    const ok = response.status >= 200 && response.status < 300;
    if (!ok) {
      this.#record({
        operation: operation.name, api: operation.api, outcome: 'upstream_error',
        status: String(response.status), amount, request_id: requestId
      });
      return new BrokerResult({ ok: false, status: 'upstream_error', http_status: response.status });
    }

    const emitted = operation.endpoint.emits
      ? readPath(response.json, REFERENCE_PATHS[operation.endpoint.emits]) ?? null
      : null;

    const notes = [];
    if (approved) notes.push('operator_approved');
    if (operation.endpoint.emits === 'capture_id') {
      const captured = readPath(response.json, CAPTURED_AMOUNT_PATH);
      if (typeof captured === 'string' && /^\d+\.\d{2}$/.test(captured)) notes.push(`captured:${captured}`);
    }
    if (operation.api === 'payments_v2.refund') notes.push(`capture:${reference}`);

    this.#record({
      operation: operation.name, api: operation.api, outcome: 'executed',
      status: String(response.status), amount,
      currency: this.#boundCurrency(operation),
      reference: emitted ?? reference,
      reference_kind: operation.endpoint.emits ?? operation.endpoint.reference,
      request_id: requestId,
      detail: notes.length > 0 ? notes.join('|') : null
    });

    return this.#reduce(operation, response, emitted, amount, credential);
  }

  /**
   * Reduce the upstream response to the fields the operator listed, then assert that no
   * credential material survived into it. The upstream body is discarded: this is the property
   * EnigmAgent's read broker already had, kept for the write path.
   */
  #reduce(operation, response, emitted, amount, credential) {
    const fields = { ok: true, status: 'executed' };
    for (const name of operation.response) {
      if (name === 'ok' || name === 'status') continue;
      if (name === 'amount') fields.amount = amount;
      else if (name === 'currency_code') fields.currency_code = this.#boundCurrency(operation);
      else if (name === 'approve_url') fields.approve_url = payerApprovalLink(response.json);
      else if (name === 'paypal_status') fields.paypal_status = paypalStatus(response.json);
      else if (name === operation.endpoint.emits) fields[name] = emitted;
    }
    const check = assertNoCredential(fields, [credential.clientId, credential.clientSecret]);
    if (!check.ok) {
      // Should be unreachable: nothing from the upstream body is copied into `fields`. It is
      // asserted anyway, and a failure is the most serious incident class there is.
      this.#record({
        operation: operation.name, api: operation.api, outcome: 'credential_exposed',
        detail: check.leaked
      });
      return new BrokerResult({ ok: false, status: 'blocked_credential_exposure' });
    }
    return new BrokerResult(fields);
  }

  #boundCurrency(operation) {
    // Orders and refunds spell it `currency_code`; Payouts spells it `currency`.
    for (const entry of operation.bound) {
      const tail = entry.path[entry.path.length - 1];
      if (tail === 'currency_code' || tail === 'currency') return entry.value;
    }
    return null;
  }

  #deriveRequestId(operation, body, reference) {
    const window = Math.floor(this.#clock() / 60_000);
    return createHash('sha256')
      .update([operation.name, JSON.stringify(body ?? null), reference ?? '', window].join('\u001f'), 'utf8')
      .digest('hex')
      .slice(0, 36);
  }

  async #accessToken(credential) {
    const now = this.#clock();
    if (this.#tokenCache && this.#tokenCache.expiresAt > now + 30_000) {
      return this.#tokenCache.accessToken;
    }
    const { accessToken, expiresIn } = await this.#transport.token(credential);
    this.#tokenCache = { accessToken, expiresAt: now + Math.max(expiresIn, 60) * 1000 };
    return accessToken;
  }

  /** Every ledger write goes through here, stamped with the broker's clock. */
  #record(entry) {
    return this.#ledger.append({ at: new Date(this.#clock()).toISOString(), ...entry });
  }

  #refuse(operation, code, detail = null, extra = {}) {
    const outcome = BOUNDARY_ATTEMPTS[code] ?? 'refused';
    this.#record({
      operation: operation.name ?? String(operation.operation ?? ''),
      api: operation.api ?? '',
      outcome,
      amount: extra.amount ?? null,
      detail: detail ? `${code}:${String(detail).slice(0, 160)}` : code
    });
    const hint = REFUSAL_HINTS[code];
    return new BrokerResult({ ok: false, status: code, ...(hint ? { hint } : {}) });
  }
}

/**
 * Approvals a human operator clears in the console. Nothing moves while a ticket waits.
 *
 * With a `path`, the queue is stored on disk and reloaded on every read. That is what makes the
 * approval flow real: the agent runs in one process (the MCP server) and the operator's console
 * in another, and an in-memory queue meant the console simply never saw the agent's request.
 *
 * An identical pending request does not create a second ticket. Otherwise asking twice produced
 * two tickets, and approving both paid twice.
 */
export class ApprovalQueue {
  #tickets = new Map();
  #counter = 0;
  #path;

  constructor(path = null) {
    this.#path = path;
    this.#load();
  }

  #load() {
    if (!this.#path || !existsSync(this.#path)) return;
    try {
      const stored = JSON.parse(readFileSync(this.#path, 'utf8'));
      this.#tickets = new Map(stored.tickets.map(ticket => [ticket.id, ticket]));
      this.#counter = stored.counter ?? this.#tickets.size;
    } catch {
      // A corrupt queue file must not take the broker down; it is re-created on the next write.
      this.#tickets = new Map();
    }
  }

  #save() {
    if (!this.#path) return;
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify({
      counter: this.#counter, tickets: [...this.#tickets.values()]
    }, null, 2), 'utf8');
  }

  /** What makes two pending requests the same request. */
  static #fingerprint(ticket) {
    return JSON.stringify([ticket.operation, ticket.params, ticket.reference ?? null, ticket.amount ?? null]);
  }

  enqueue(ticket) {
    this.#load();
    const fingerprint = ApprovalQueue.#fingerprint(ticket);
    for (const existing of this.#tickets.values()) {
      if (ApprovalQueue.#fingerprint(existing) === fingerprint) return existing;
    }
    this.#counter += 1;
    const id = `APV-${String(this.#counter).padStart(4, '0')}`;
    const stored = { id, at: new Date().toISOString(), ...ticket };
    this.#tickets.set(id, stored);
    this.#save();
    return stored;
  }

  list() {
    this.#load();
    return [...this.#tickets.values()];
  }

  /** Read a ticket without consuming it. */
  peek(id) {
    this.#load();
    return this.#tickets.get(id) ?? null;
  }

  take(id) {
    this.#load();
    const ticket = this.#tickets.get(id);
    if (ticket) {
      this.#tickets.delete(id);
      this.#save();
    }
    return ticket ?? null;
  }

  reject(id) {
    this.#load();
    const removed = this.#tickets.delete(id);
    if (removed) this.#save();
    return removed;
  }
}
