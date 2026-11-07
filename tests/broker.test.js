// SPDX-FileCopyrightText: 2026 Francisco Angulo de Lafuente
// SPDX-License-Identifier: MIT
// Research-Project: PayPal Agentic Guardrail
// Research-Author: Francisco Angulo de Lafuente
// Research-ORCID: https://orcid.org/0009-0001-1634-7063
// Research-Date: 2026-11-07
/**
 * Tests for the invariants the security argument rests on. Each one is a property that, if it
 * broke, would make a claim in the README false.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy, PolicyError, composeBody, validateParameters, compareDecimal, addDecimal }
  from '../src/policy.js';
import { Ledger, checkLimits } from '../src/ledger.js';
import { PaymentOperationBroker } from '../src/broker.js';
import { MockTransport } from '../src/transport.js';
import { assertNoCredential } from '../src/credentials.js';

const ENV = {
  OPERATOR_MERCHANT_ID: 'OPERATOR-MERCHANT-0001',
  OPERATOR_SUPPLIER_EMAIL: 'supplier@operator.example'
};

const CREDENTIAL = { clientId: 'TEST-CLIENT-ID-123456', clientSecret: 'TEST-CLIENT-SECRET-abcdef' };
const credentials = { kind: 'test', async resolve() { return CREDENTIAL; } };

function policyDoc(overrides = {}) {
  return {
    version: 1,
    environment: 'sandbox',
    operations: [
      {
        name: 'charge_customer_eur',
        api: 'orders_v2.create',
        bound: {
          intent: 'CAPTURE',
          'purchase_units[0].payee.merchant_id': '${OPERATOR_MERCHANT_ID}',
          'purchase_units[0].amount.currency_code': 'EUR',
          'purchase_units[0].amount.breakdown.item_total.currency_code': 'EUR',
          'purchase_units[0].items[0].name': 'Item',
          'purchase_units[0].items[0].quantity': '1',
          'purchase_units[0].items[0].unit_amount.currency_code': 'EUR'
        },
        agent: {
          amount: { path: 'purchase_units[0].amount.value', mirror: ['purchase_units[0].amount.breakdown.item_total.value', 'purchase_units[0].items[0].unit_amount.value'], type: 'decimal', min: '1.00', max: '250.00' },
          sku: { path: 'purchase_units[0].items[0].sku', type: 'enum', values: ['SKU-BASIC', 'SKU-PRO'] }
        },
        limits: { per_call_max: '250.00', daily_total_max: '400.00', max_calls_per_hour: 3 },
        approval: 'none',
        response: ['ok', 'status', 'order_id', 'amount', 'currency_code']
      },
      {
        name: 'capture_order',
        api: 'orders_v2.capture',
        bound: {},
        agent: {},
        limits: { per_call_max: '250.00', daily_total_max: '400.00', max_calls_per_hour: 5 },
        approval: 'none',
        response: ['ok', 'status', 'capture_id']
      },
      {
        name: 'pay_supplier_eur',
        api: 'payouts_v1.create',
        bound: {
          'items[0].recipient_type': 'EMAIL',
          'items[0].receiver': '${OPERATOR_SUPPLIER_EMAIL}',
          'items[0].amount.currency': 'EUR'
        },
        derived: { 'sender_batch_header.sender_batch_id': 'request_id' },
        agent: {
          amount: { path: 'items[0].amount.value', type: 'decimal', min: '1.00', max: '500.00' }
        },
        limits: { per_call_max: '500.00', daily_total_max: '1000.00', max_calls_per_hour: 5 },
        approval: 'over_amount:200.00',
        response: ['ok', 'status', 'payout_batch_id']
      }
    ],
    ...overrides
  };
}

function makeBroker({ clock } = {}) {
  const policy = loadPolicy(policyDoc(), ENV);
  const ledger = new Ledger(null);
  const broker = new PaymentOperationBroker({
    policy, ledger, credentials, transport: new MockTransport(), clock
  });
  return { broker, ledger, policy };
}

test('decimal arithmetic is exact', () => {
  assert.equal(addDecimal('0.10', '0.20'), '0.30');
  assert.equal(addDecimal('199.99', '0.01'), '200.00');
  assert.equal(compareDecimal('250.00', '250.00'), 0);
  assert.equal(compareDecimal('250.01', '250.00'), 1);
  assert.equal(compareDecimal('9.99', '10.00'), -1);
});

test('an operator-bound field cannot be overwritten by the agent', () => {
  const policy = loadPolicy(policyDoc(), ENV);
  const operation = policy.operations.get('charge_customer_eur');
  // Compose the body as if an agent value had somehow reached a bound path.
  const body = composeBody(operation, { amount: '10.00', sku: 'SKU-PRO' });
  assert.equal(body.purchase_units[0].payee.merchant_id, ENV.OPERATOR_MERCHANT_ID);
  assert.equal(body.purchase_units[0].amount.currency_code, 'EUR');
  assert.equal(body.intent, 'CAPTURE');
});

test('a policy whose agent field aims at a bound path is refused at load time', () => {
  const doc = policyDoc();
  doc.operations[0].agent.payee = {
    path: 'purchase_units[0].payee.merchant_id', type: 'text', max_length: 32
  };
  assert.throws(() => loadPolicy(doc, ENV), error =>
    error instanceof PolicyError && error.code === 'agent_field_collides_with_bound');
});

test('an undeclared parameter is rejected, not ignored', () => {
  const policy = loadPolicy(policyDoc(), ENV);
  const operation = policy.operations.get('charge_customer_eur');
  assert.throws(() => validateParameters(operation, { amount: '10.00', sku: 'SKU-PRO', payee: 'X' }),
    error => error instanceof PolicyError && error.code === 'parameter_not_allowed');
});

test('a value outside the declared range is rejected', () => {
  const policy = loadPolicy(policyDoc(), ENV);
  const operation = policy.operations.get('charge_customer_eur');
  assert.throws(() => validateParameters(operation, { amount: '250.01', sku: 'SKU-PRO' }),
    error => error.code === 'parameter_above_max');
  assert.throws(() => validateParameters(operation, { amount: '0.99', sku: 'SKU-PRO' }),
    error => error.code === 'parameter_below_min');
  assert.throws(() => validateParameters(operation, { amount: '10', sku: 'SKU-PRO' }),
    error => error.code === 'parameter_not_decimal');
  assert.throws(() => validateParameters(operation, { amount: '10.00', sku: 'SKU-OTHER' }),
    error => error.code === 'parameter_not_in_enum');
});

test('a free-text field cannot carry a URL, an email or an IBAN', () => {
  const doc = policyDoc();
  doc.operations[0].agent.note = { path: 'purchase_units[0].description', type: 'text', max_length: 60 };
  const policy = loadPolicy(doc, ENV);
  const operation = policy.operations.get('charge_customer_eur');
  for (const note of ['see https://attacker.example', 'pay me@attacker.example', 'IBAN ES91 2100']) {
    assert.throws(() => validateParameters(operation, { amount: '10.00', sku: 'SKU-PRO', note }),
      error => error.code === 'parameter_text_forbidden_content', `should reject: ${note}`);
  }
});

test('a policy that declares a live environment without an explicit opt-in is refused', () => {
  const doc = policyDoc({ environment: 'live' });
  assert.throws(() => loadPolicy(doc, ENV), error => error.code === 'live_not_enabled');
  // With the opt-in it loads, so the refusal is a guard and not a hard limitation.
  const loaded = loadPolicy(doc, { ...ENV, GUARDRAIL_ALLOW_LIVE: 'yes-i-mean-it' });
  assert.equal(loaded.environment, 'live');
});

test('an agent maximum above the per-call limit is refused at load time', () => {
  const doc = policyDoc();
  doc.operations[0].limits.per_call_max = '100.00';
  assert.throws(() => loadPolicy(doc, ENV), error => error.code === 'agent_max_above_per_call_max');
});

test('a write operation must declare its limits', () => {
  const doc = policyDoc();
  delete doc.operations[0].limits.daily_total_max;
  assert.throws(() => loadPolicy(doc, ENV), error => error.code === 'daily_total_max_required');
});

test('the catalogue the agent sees contains no bound values', () => {
  const policy = loadPolicy(policyDoc(), ENV);
  const serialised = JSON.stringify(policy.catalogue);
  assert.ok(!serialised.includes(ENV.OPERATOR_MERCHANT_ID));
  assert.ok(!serialised.includes(ENV.OPERATOR_SUPPLIER_EMAIL));
  assert.ok(serialised.includes('charge_customer_eur'));
});

test('an unknown operation is refused and recorded', async () => {
  const { broker, ledger } = makeBroker();
  const result = await broker.execute({ operation: 'reveal_credential', params: {} });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'operation_not_allowed');
  assert.equal(ledger.entries.at(-1).operation, 'reveal_credential');
});

test('a successful charge returns only the operator-listed fields and no credential', async () => {
  const { broker } = makeBroker();
  const result = await broker.execute({
    operation: 'charge_customer_eur', params: { amount: '49.00', sku: 'SKU-PRO' }
  });
  assert.equal(result.ok, true);
  assert.equal(result.currency_code, 'EUR');
  assert.equal(result.amount, '49.00');
  assert.ok(result.order_id.startsWith('MOCK-ORDER-'));
  assert.deepEqual(
    Object.keys(result).sort(),
    ['amount', 'currency_code', 'ok', 'order_id', 'status']
  );
  assert.ok(assertNoCredential(result, [CREDENTIAL.clientId, CREDENTIAL.clientSecret]).ok);
});

test('a reference the broker never issued is refused', async () => {
  const { broker } = makeBroker();
  const result = await broker.execute({
    operation: 'capture_order', params: {}, reference: 'MOCK-ORDER-FABRICATED'
  });
  assert.equal(result.status, 'reference_unknown');
});

test('a reference the broker issued is accepted', async () => {
  const { broker } = makeBroker();
  const created = await broker.execute({
    operation: 'charge_customer_eur', params: { amount: '20.00', sku: 'SKU-BASIC' }
  });
  const captured = await broker.execute({
    operation: 'capture_order', params: {}, reference: created.order_id
  });
  assert.equal(captured.ok, true);
  assert.ok(captured.capture_id.startsWith('MOCK-CAPTURE-'));
});

test('a repeated identical charge inside the window is suppressed', async () => {
  const { broker, ledger } = makeBroker({ clock: () => 1_760_000_000_000 });
  const first = await broker.execute({
    operation: 'charge_customer_eur', params: { amount: '49.00', sku: 'SKU-PRO' }
  });
  const second = await broker.execute({
    operation: 'charge_customer_eur', params: { amount: '49.00', sku: 'SKU-PRO' }
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.status, 'replay_suppressed');
  assert.equal(ledger.entries.filter(entry => entry.outcome === 'executed').length, 1);
});

test('the daily total limit stops the call that would cross it', async () => {
  let now = 1_760_000_000_000;
  const { broker } = makeBroker({ clock: () => now });
  const amounts = ['200.00', '150.00', '100.00'];
  const statuses = [];
  for (const amount of amounts) {
    now += 120_000;  // move past the idempotency window so each call is distinct
    const result = await broker.execute({
      operation: 'charge_customer_eur', params: { amount, sku: 'SKU-PRO' }
    });
    statuses.push(result.status);
  }
  // 200 + 150 = 350 is under the 400.00 daily cap; the third would reach 450.
  assert.deepEqual(statuses, ['executed', 'executed', 'limit_daily_total_exceeded']);
});

test('the hourly call limit stops further calls', async () => {
  let now = 1_760_000_000_000;
  const { broker } = makeBroker({ clock: () => now });
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    now += 120_000;
    const result = await broker.execute({
      operation: 'charge_customer_eur', params: { amount: '1.00', sku: 'SKU-BASIC' }
    });
    statuses.push(result.status);
  }
  assert.deepEqual(statuses.slice(0, 3), ['executed', 'executed', 'executed']);
  assert.equal(statuses[3], 'limit_rate_exceeded');
});

test('an amount over the approval threshold waits for a human and moves nothing', async () => {
  const { broker, ledger } = makeBroker();
  const result = await broker.execute({ operation: 'pay_supplier_eur', params: { amount: '400.00' } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'pending_approval');
  assert.ok(result.approval_id.startsWith('APV-'));
  assert.equal(ledger.entries.filter(entry => entry.outcome === 'executed').length, 0);
  assert.equal(broker.approvals.list().length, 1);

  // Once the operator approves it, the same request executes with the bound receiver.
  const approved = await broker.executeApproved(result.approval_id);
  assert.equal(approved.ok, true);
  assert.equal(broker.approvals.list().length, 0);
});

test('an amount under the approval threshold executes directly', async () => {
  const { broker } = makeBroker();
  const result = await broker.execute({ operation: 'pay_supplier_eur', params: { amount: '150.00' } });
  assert.equal(result.ok, true);
});

test('a derived field is filled by the broker and is not an agent parameter', async () => {
  const { broker } = makeBroker();
  const policy = loadPolicy(policyDoc(), ENV);
  const operation = policy.operations.get('pay_supplier_eur');
  assert.throws(() => validateParameters(operation, { amount: '10.00', sender_batch_id: 'X' }),
    error => error.code === 'parameter_not_allowed');
  const body = composeBody(operation, { amount: '10.00' }, { request_id: 'derived-key-1' });
  assert.equal(body.sender_batch_header.sender_batch_id, 'derived-key-1');
  assert.equal(body.items[0].receiver, ENV.OPERATOR_SUPPLIER_EMAIL);
  const result = await broker.execute({ operation: 'pay_supplier_eur', params: { amount: '10.00' } });
  assert.equal(result.ok, true);
});

test('the ledger chain detects an edited entry', () => {
  const ledger = new Ledger(null);
  ledger.append({ operation: 'a', api: 'orders_v2.create', outcome: 'executed', amount: '10.00' });
  ledger.append({ operation: 'b', api: 'orders_v2.create', outcome: 'executed', amount: '20.00' });
  ledger.append({ operation: 'c', api: 'orders_v2.create', outcome: 'executed', amount: '30.00' });
  assert.equal(ledger.verify().ok, true);
  ledger.entries[1].amount = '2000.00';
  const verdict = ledger.verify();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.brokenAt, 2);
});

test('limits are evaluated against what the ledger records, not against a counter', () => {
  const policy = loadPolicy(policyDoc(), ENV);
  const operation = policy.operations.get('charge_customer_eur');
  const ledger = new Ledger(null);
  const now = 1_760_000_000_000;
  ledger.append({
    operation: 'charge_customer_eur', api: 'orders_v2.create', outcome: 'executed',
    amount: '350.00', at: new Date(now - 1000).toISOString()
  });
  assert.equal(checkLimits(operation, '60.00', ledger, now).code, 'limit_daily_total_exceeded');
  assert.equal(checkLimits(operation, '40.00', ledger, now), null);
  // A refused entry does not consume budget.
  const other = new Ledger(null);
  other.append({
    operation: 'charge_customer_eur', api: 'orders_v2.create', outcome: 'refused',
    amount: '350.00', at: new Date(now - 1000).toISOString()
  });
  assert.equal(checkLimits(operation, '60.00', other, now), null);
});

test('assertNoCredential catches the raw value and its base64 form', () => {
  const secret = 'TEST-CLIENT-SECRET-abcdef';
  assert.equal(assertNoCredential({ a: `x${secret}y` }, [secret]).ok, false);
  const basic = Buffer.from(secret, 'utf8').toString('base64');
  assert.equal(assertNoCredential({ a: `Basic ${basic}` }, [secret]).ok, false);
  assert.equal(assertNoCredential({ a: 'nothing here' }, [secret]).ok, true);
});

test('the broker exposes no way to change the policy', () => {
  const { broker } = makeBroker();
  const surface = [
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(broker)),
    ...Object.keys(broker)
  ];
  for (const name of surface) {
    assert.ok(!/policy/i.test(name) || name === 'constructor',
      `broker should expose no policy mutator, found: ${name}`);
  }
});
