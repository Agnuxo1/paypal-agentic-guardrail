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
import { composeBody, PolicyError, validateParameters } from './policy.js';
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
  policy_write_rejected: 'policy_mutation_attempt'
});

export class BrokerResult {
  constructor(fields) {
    Object.assign(this, fields);
    Object.freeze(this);
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
   * Anything else in `request` is ignored by construction: no URL, no header, no destination.
   */
  async execute(request) {
    const operationName = typeof request?.operation === 'string' ? request.operation : '';
    const operation = this.#policy.operations.get(operationName);
    if (!operation) {
      return this.#refuse({ operation: operationName || '(none)', api: '' }, 'operation_not_allowed');
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

    const limitRefusal = checkLimits(operation, amount, this.#ledger, this.#clock());
    if (limitRefusal) {
      return this.#refuse(operation, limitRefusal.code, limitRefusal.detail, { amount });
    }

    if (this.#requiresApproval(operation, amount)) {
      const ticket = this.#approvals.enqueue({ operation: operation.name, params: values, reference, amount });
      this.#ledger.append({
        operation: operation.name, api: operation.api, outcome: 'pending_approval',
        amount, detail: ticket.id
      });
      return new BrokerResult({ ok: false, status: 'pending_approval', approval_id: ticket.id });
    }

    return this.#dispatch(operation, values, reference, amount);
  }

  /** Execute a request a human operator approved in the console. */
  async executeApproved(approvalId) {
    const ticket = this.#approvals.take(approvalId);
    if (!ticket) return new BrokerResult({ ok: false, status: 'approval_not_found' });
    const operation = this.#policy.operations.get(ticket.operation);
    if (!operation) return new BrokerResult({ ok: false, status: 'operation_not_allowed' });
    return this.#dispatch(operation, ticket.params, ticket.reference, ticket.amount, true);
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
      this.#ledger.append({
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
      this.#ledger.append({
        operation: operation.name, api: operation.api, outcome, amount,
        detail: error.code ?? 'unknown', request_id: requestId
      });
      return new BrokerResult({ ok: false, status: outcome });
    }

    const ok = response.status >= 200 && response.status < 300;
    if (!ok) {
      this.#ledger.append({
        operation: operation.name, api: operation.api, outcome: 'upstream_error',
        status: String(response.status), amount, request_id: requestId
      });
      return new BrokerResult({ ok: false, status: 'upstream_error', http_status: response.status });
    }

    const emitted = operation.endpoint.emits
      ? readPath(response.json, REFERENCE_PATHS[operation.endpoint.emits]) ?? null
      : null;

    this.#ledger.append({
      operation: operation.name, api: operation.api, outcome: 'executed',
      status: String(response.status), amount,
      currency: this.#boundCurrency(operation),
      reference: emitted ?? reference,
      reference_kind: operation.endpoint.emits ?? operation.endpoint.reference,
      request_id: requestId,
      detail: approved ? 'operator_approved' : null
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
      else if (name === operation.endpoint.emits) fields[name] = emitted;
    }
    const check = assertNoCredential(fields, [credential.clientId, credential.clientSecret]);
    if (!check.ok) {
      // Should be unreachable: nothing from the upstream body is copied into `fields`. It is
      // asserted anyway, and a failure is the most serious incident class there is.
      this.#ledger.append({
        operation: operation.name, api: operation.api, outcome: 'credential_exposed',
        detail: check.leaked
      });
      return new BrokerResult({ ok: false, status: 'blocked_credential_exposure' });
    }
    return new BrokerResult(fields);
  }

  #boundCurrency(operation) {
    for (const entry of operation.bound) {
      if (entry.path[entry.path.length - 1] === 'currency_code') return entry.value;
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

  #refuse(operation, code, detail = null, extra = {}) {
    const outcome = BOUNDARY_ATTEMPTS[code] ?? (PLAIN_REFUSALS.has(code) ? 'refused' : 'refused');
    this.#ledger.append({
      operation: operation.name ?? String(operation.operation ?? ''),
      api: operation.api ?? '',
      outcome,
      amount: extra.amount ?? null,
      detail: detail ? `${code}:${String(detail).slice(0, 160)}` : code
    });
    return new BrokerResult({ ok: false, status: code });
  }
}

/** Approvals a human operator clears in the console. Nothing moves while a ticket waits. */
export class ApprovalQueue {
  #tickets = new Map();
  #counter = 0;

  enqueue(ticket) {
    this.#counter += 1;
    const id = `APV-${String(this.#counter).padStart(4, '0')}`;
    const stored = { id, at: new Date().toISOString(), ...ticket };
    this.#tickets.set(id, stored);
    return stored;
  }

  list() {
    return [...this.#tickets.values()];
  }

  take(id) {
    const ticket = this.#tickets.get(id);
    if (ticket) this.#tickets.delete(id);
    return ticket ?? null;
  }

  reject(id) {
    return this.#tickets.delete(id);
  }
}
