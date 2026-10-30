/**
 * The operator policy: load, validate, and apply.
 *
 * The policy is the only source of three things the agent must never control: the destination,
 * the payee, and the ceiling on the amount. It is a plain JSON document that only a human
 * operator edits. There is deliberately no operation that edits it, so `policy_mutation_attempt`
 * is always a rejection and never a code path.
 *
 * Every operation declares three classes of field:
 *   bound   - fixed by the operator; applied last, so an agent value can never survive
 *   agent   - chosen by the agent, inside a closed schema (type, range, enum, length, pattern)
 *   derived - computed by the broker; invisible to the agent (idempotency key, OAuth token)
 */

import { readFileSync } from 'node:fs';
import { endpointFor } from './paypal-api.js';

export class PolicyError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const DECIMAL = /^(0|[1-9]\d{0,9})\.\d{2}$/;
const OPERATION_NAME = /^[a-z][a-z0-9_]{2,63}$/;
/** A note must not be able to smuggle a destination into a human-readable field. */
const NOTE_FORBIDDEN = /(https?:\/\/|\bwww\.|@|\bIBAN\b|\bBIC\b|[<>{}])/i;

const FIELD_TYPES = new Set(['decimal', 'enum', 'text', 'integer']);
const APPROVAL = /^(none|always|over_amount:(0|[1-9]\d{0,9})\.\d{2})$/;
const RESPONSE_FIELDS = new Set([
  'ok', 'status', 'order_id', 'capture_id', 'authorization_id', 'refund_id',
  'payout_batch_id', 'amount', 'currency_code'
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Compare two decimal strings of the form `123.45` without floating point. */
export function compareDecimal(a, b) {
  const [ai, af] = a.split('.');
  const [bi, bf] = b.split('.');
  const left = BigInt(ai) * 100n + BigInt(af);
  const right = BigInt(bi) * 100n + BigInt(bf);
  return left === right ? 0 : (left < right ? -1 : 1);
}

export function addDecimal(a, b) {
  const [ai, af] = a.split('.');
  const [bi, bf] = b.split('.');
  const total = BigInt(ai) * 100n + BigInt(af) + BigInt(bi) * 100n + BigInt(bf);
  return `${total / 100n}.${String(total % 100n).padStart(2, '0')}`;
}

/**
 * A field path into the request body, written as `purchase_units[0].amount.value`.
 * Parsed once at load time so no string handling happens on the request path.
 */
export function parsePath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) {
    throw new PolicyError('invalid_path', String(raw));
  }
  const steps = [];
  for (const segment of raw.split('.')) {
    const match = /^([a-zA-Z_][a-zA-Z0-9_]*)((\[\d+\])*)$/.exec(segment);
    if (!match) throw new PolicyError('invalid_path', raw);
    steps.push(match[1]);
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) steps.push(Number(index[1]));
  }
  return Object.freeze(steps);
}

export function setPath(target, steps, value) {
  let node = target;
  for (let i = 0; i < steps.length - 1; i += 1) {
    const step = steps[i];
    const nextIsIndex = typeof steps[i + 1] === 'number';
    if (node[step] === undefined || node[step] === null) node[step] = nextIsIndex ? [] : {};
    node = node[step];
  }
  node[steps[steps.length - 1]] = value;
  return target;
}

function validateAgentField(name, spec) {
  if (!isObject(spec)) throw new PolicyError('invalid_agent_field', name);
  if (!FIELD_TYPES.has(spec.type)) throw new PolicyError('invalid_field_type', `${name}:${spec.type}`);
  const field = { name, type: spec.type, path: parsePath(spec.path) };
  if (spec.type === 'decimal') {
    if (!DECIMAL.test(spec.min ?? '') || !DECIMAL.test(spec.max ?? '')) {
      throw new PolicyError('decimal_bounds_required', name);
    }
    if (compareDecimal(spec.min, spec.max) > 0) throw new PolicyError('decimal_bounds_inverted', name);
    field.min = spec.min;
    field.max = spec.max;
  } else if (spec.type === 'integer') {
    if (!Number.isInteger(spec.min) || !Number.isInteger(spec.max) || spec.min > spec.max) {
      throw new PolicyError('integer_bounds_required', name);
    }
    field.min = spec.min;
    field.max = spec.max;
  } else if (spec.type === 'enum') {
    if (!Array.isArray(spec.values) || spec.values.length === 0 || spec.values.length > 64 ||
        spec.values.some(value => typeof value !== 'string' || value.length === 0 || value.length > 64)) {
      throw new PolicyError('enum_values_required', name);
    }
    field.values = Object.freeze([...spec.values]);
  } else {
    if (!Number.isInteger(spec.max_length) || spec.max_length < 1 || spec.max_length > 512) {
      throw new PolicyError('text_max_length_required', name);
    }
    field.maxLength = spec.max_length;
  }
  return Object.freeze(field);
}

function validateOperation(raw, index) {
  if (!isObject(raw)) throw new PolicyError('invalid_operation', `#${index}`);
  if (!OPERATION_NAME.test(raw.name ?? '')) throw new PolicyError('invalid_operation_name', String(raw.name));
  const endpoint = endpointFor(raw.api);

  if (!isObject(raw.bound)) throw new PolicyError('bound_required', raw.name);
  const bound = [];
  for (const [path, value] of Object.entries(raw.bound)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new PolicyError('bound_value_type', `${raw.name}.${path}`);
    }
    bound.push(Object.freeze({ path: parsePath(path), value }));
  }

  const agent = [];
  const agentNames = new Set();
  for (const [name, spec] of Object.entries(raw.agent ?? {})) {
    if (!OPERATION_NAME.test(name)) throw new PolicyError('invalid_agent_field_name', name);
    agentNames.add(name);
    agent.push(validateAgentField(name, spec));
  }

  // `derived` fields are filled by the broker from values it computed itself. The only source
  // is the server-derived idempotency key, which PayPal's Payouts API also wants in the body
  // as `sender_batch_id`. The agent can neither read nor set these.
  const derived = [];
  for (const [path, source] of Object.entries(raw.derived ?? {})) {
    if (source !== 'request_id') throw new PolicyError('invalid_derived_source', `${raw.name}.${path}`);
    derived.push(Object.freeze({ path: parsePath(path), source }));
  }

  // An agent field may not aim at a path the operator has bound or the broker derives: that
  // would make the precedence rule the only thing standing between the agent and the payee.
  const reservedPaths = new Set([
    ...bound.map(entry => entry.path.join('.')),
    ...derived.map(entry => entry.path.join('.'))
  ]);
  for (const field of agent) {
    if (reservedPaths.has(field.path.join('.'))) {
      throw new PolicyError('agent_field_collides_with_bound', `${raw.name}.${field.name}`);
    }
  }

  const limits = raw.limits ?? {};
  if (endpoint.writes) {
    if (!DECIMAL.test(limits.per_call_max ?? '')) throw new PolicyError('per_call_max_required', raw.name);
    if (!DECIMAL.test(limits.daily_total_max ?? '')) throw new PolicyError('daily_total_max_required', raw.name);
    if (!Number.isInteger(limits.max_calls_per_hour) || limits.max_calls_per_hour < 1 ||
        limits.max_calls_per_hour > 10000) {
      throw new PolicyError('max_calls_per_hour_required', raw.name);
    }
  }

  const approval = raw.approval ?? 'none';
  if (!APPROVAL.test(approval)) throw new PolicyError('invalid_approval', `${raw.name}:${approval}`);

  const response = raw.response ?? ['ok', 'status'];
  if (!Array.isArray(response) || response.length === 0 ||
      response.some(field => !RESPONSE_FIELDS.has(field))) {
    throw new PolicyError('invalid_response_fields', raw.name);
  }

  // A write that moves money must declare an amount ceiling the agent cannot exceed, either
  // as a bound constant or as an agent field whose `max` is at or below `per_call_max`.
  const amountField = agent.find(field => field.type === 'decimal');
  if (endpoint.writes && amountField && compareDecimal(amountField.max, limits.per_call_max) > 0) {
    throw new PolicyError('agent_max_above_per_call_max', raw.name);
  }

  return Object.freeze({
    name: raw.name,
    api: raw.api,
    endpoint,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 200) : '',
    bound: Object.freeze(bound),
    derived: Object.freeze(derived),
    agent: Object.freeze(agent),
    agentNames: Object.freeze(agentNames),
    limits: Object.freeze({
      perCallMax: limits.per_call_max ?? null,
      dailyTotalMax: limits.daily_total_max ?? null,
      maxCallsPerHour: limits.max_calls_per_hour ?? null
    }),
    approval,
    response: Object.freeze([...response]),
    amountFieldName: amountField?.name ?? null
  });
}

/**
 * `${VAR}` in a bound value is read from the environment at load time, so a merchant id or a
 * receiver address lives in the operator's environment and not in the repository.
 */
function expandEnv(value, env) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z][A-Z0-9_]{0,63})\}/g, (_, name) => {
    const resolved = env[name];
    if (resolved === undefined || resolved === '') throw new PolicyError('missing_env', name);
    return resolved;
  });
}

export function loadPolicy(raw, env = process.env) {
  if (!isObject(raw)) throw new PolicyError('invalid_policy');
  if (raw.version !== 1) throw new PolicyError('unsupported_policy_version', String(raw.version));
  if (!['sandbox', 'live'].includes(raw.environment)) {
    throw new PolicyError('invalid_environment', String(raw.environment));
  }
  if (raw.environment === 'live' && env.GUARDRAIL_ALLOW_LIVE !== 'yes-i-mean-it') {
    // This project is a hackathon entry evaluated in sandbox. Live is refused unless an
    // operator opts in deliberately, so a copied policy file cannot move real money.
    throw new PolicyError('live_not_enabled');
  }
  if (!Array.isArray(raw.operations) || raw.operations.length === 0) {
    throw new PolicyError('operations_required');
  }
  if (raw.operations.length > 128) throw new PolicyError('too_many_operations');

  const expanded = raw.operations.map(operation => ({
    ...operation,
    bound: Object.fromEntries(
      Object.entries(operation.bound ?? {}).map(([path, value]) => [path, expandEnv(value, env)])
    )
  }));

  const operations = new Map();
  expanded.forEach((operation, index) => {
    const validated = validateOperation(operation, index);
    if (operations.has(validated.name)) throw new PolicyError('duplicate_operation', validated.name);
    operations.set(validated.name, validated);
  });

  return Object.freeze({
    version: 1,
    environment: raw.environment,
    operations,
    /** Metadata the agent is allowed to see: names and bounded shapes, never bound values. */
    catalogue: Object.freeze([...operations.values()].map(operation => Object.freeze({
      name: operation.name,
      description: operation.description,
      parameters: Object.freeze(operation.agent.map(field => Object.freeze(
        field.type === 'enum'
          ? { name: field.name, type: 'enum', values: field.values }
          : field.type === 'decimal'
            ? { name: field.name, type: 'decimal', min: field.min, max: field.max }
            : field.type === 'integer'
              ? { name: field.name, type: 'integer', min: field.min, max: field.max }
              : { name: field.name, type: 'text', max_length: field.maxLength }
      ))),
      requires_reference: operation.endpoint.reference,
      approval: operation.approval
    })))
  });
}

export function loadPolicyFile(path, env = process.env) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new PolicyError('policy_unreadable', error.message);
  }
  return loadPolicy(parsed, env);
}

/**
 * Validate the agent's parameters against the closed schema.
 * Returns `{ values }` or throws a PolicyError whose code the broker turns into a result.
 * An undeclared parameter is rejected, never dropped silently: dropping it would hide an
 * attack that the ledger should record.
 */
export function validateParameters(operation, params) {
  if (!isObject(params)) throw new PolicyError('parameters_not_object');
  for (const key of Object.keys(params)) {
    if (!operation.agentNames.has(key)) throw new PolicyError('parameter_not_allowed', key);
  }
  const values = {};
  for (const field of operation.agent) {
    const given = params[field.name];
    if (given === undefined) throw new PolicyError('parameter_missing', field.name);
    if (field.type === 'decimal') {
      if (typeof given !== 'string' || !DECIMAL.test(given)) {
        throw new PolicyError('parameter_not_decimal', field.name);
      }
      if (compareDecimal(given, field.min) < 0) throw new PolicyError('parameter_below_min', field.name);
      if (compareDecimal(given, field.max) > 0) throw new PolicyError('parameter_above_max', field.name);
      values[field.name] = given;
    } else if (field.type === 'integer') {
      if (!Number.isInteger(given) || given < field.min || given > field.max) {
        throw new PolicyError('parameter_out_of_range', field.name);
      }
      values[field.name] = given;
    } else if (field.type === 'enum') {
      if (typeof given !== 'string' || !field.values.includes(given)) {
        throw new PolicyError('parameter_not_in_enum', field.name);
      }
      values[field.name] = given;
    } else {
      if (typeof given !== 'string' || given.length === 0 || given.length > field.maxLength) {
        throw new PolicyError('parameter_text_invalid', field.name);
      }
      if (NOTE_FORBIDDEN.test(given)) throw new PolicyError('parameter_text_forbidden_content', field.name);
      values[field.name] = given;
    }
  }
  return values;
}

/**
 * Compose the request body: agent values first, operator bound values last.
 *
 * The order is the whole point. Even if validation were bypassed and an agent value reached a
 * bound path, the operator's write would overwrite it before the request leaves the process.
 */
export function composeBody(operation, values, derivedValues = {}) {
  const body = {};
  for (const field of operation.agent) {
    setPath(body, field.path, values[field.name]);
  }
  for (const entry of operation.bound) {
    setPath(body, entry.path, entry.value);
  }
  for (const entry of operation.derived) {
    setPath(body, entry.path, derivedValues[entry.source]);
  }
  return body;
}

export const PATTERNS = Object.freeze({ DECIMAL, NOTE_FORBIDDEN });
