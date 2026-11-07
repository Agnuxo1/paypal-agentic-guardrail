// SPDX-FileCopyrightText: 2026 Francisco Angulo de Lafuente
// SPDX-License-Identifier: MIT
// Research-Project: PayPal Agentic Guardrail
// Research-Author: Francisco Angulo de Lafuente
// Research-ORCID: https://orcid.org/0009-0001-1634-7063
// Research-Date: 2026-11-07
/**
 * Tests for the failures an independent review found after the first version shipped. Each one
 * here is a bug that was real, reproduced, and fixed — kept so it cannot come back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy, PolicyError, validateParameters } from '../src/policy.js';
import { Ledger } from '../src/ledger.js';
import { ApprovalQueue, PaymentOperationBroker } from '../src/broker.js';
import { MockTransport } from '../src/transport.js';

const ENV = {
  OPERATOR_MERCHANT_ID: 'OPERATOR-MERCHANT-0001',
  OPERATOR_SUPPLIER_EMAIL: 'supplier@operator.example'
};
const CREDENTIAL = { clientId: 'TEST-CLIENT-ID-123456', clientSecret: 'TEST-CLIENT-SECRET-abcdef' };
const credentials = { kind: 'test', async resolve() { return CREDENTIAL; } };

function policyDoc() {
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
          sku: { path: 'purchase_units[0].items[0].sku', type: 'enum', values: ['SKU-PRO'] }
        },
        limits: { per_call_max: '250.00', daily_total_max: '500.00', max_calls_per_hour: 100 },
        approval: 'none',
        response: ['ok', 'status', 'order_id', 'amount']
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
        agent: { amount: { path: 'items[0].amount.value', type: 'decimal', min: '1.00', max: '400.00' } },
        limits: { per_call_max: '400.00', daily_total_max: '600.00', max_calls_per_hour: 100 },
        approval: 'over_amount:200.00',
        response: ['ok', 'status', 'payout_batch_id']
      }
    ]
  };
}

function makeBroker({ clock, approvals } = {}) {
  const policy = loadPolicy(policyDoc(), ENV);
  const ledger = new Ledger(null);
  const broker = new PaymentOperationBroker({
    policy, ledger, credentials, transport: new MockTransport(), clock, approvals
  });
  return { broker, ledger };
}

test('concurrent calls cannot spend past the daily cap', async () => {
  // Reproduces the review's finding: limits are read before an await and written after it, so
  // parallel calls each saw the same remaining budget. Forty parallel calls spent five times
  // the cap. `execute` now serialises.
  let now = 1_760_000_000_000;
  const { broker, ledger } = makeBroker({ clock: () => { now += 90_000; return now; } });

  const results = await Promise.all(
    Array.from({ length: 20 }, () => broker.execute({
      operation: 'charge_customer_eur', params: { amount: '100.00', sku: 'SKU-PRO' }
    }))
  );

  const executed = results.filter(result => result.ok);
  const spent = ledger.entries
    .filter(entry => entry.outcome === 'executed')
    .reduce((total, entry) => total + Number(entry.amount), 0);

  assert.equal(executed.length, 5, 'five calls of 100.00 reach the 500.00 cap');
  assert.ok(spent <= 500, `spent ${spent} must not exceed the 500.00 daily cap`);
  assert.ok(results.some(result => result.status === 'limit_daily_total_exceeded'));
});

test('concurrent payouts cannot spend past their own cap', async () => {
  let now = 1_760_000_000_000;
  const { broker, ledger } = makeBroker({ clock: () => { now += 90_000; return now; } });
  await Promise.all(
    Array.from({ length: 10 }, () => broker.execute({
      operation: 'pay_supplier_eur', params: { amount: '150.00' }
    }))
  );
  const spent = ledger.entries
    .filter(entry => entry.outcome === 'executed')
    .reduce((total, entry) => total + Number(entry.amount), 0);
  assert.ok(spent <= 600, `spent ${spent} must not exceed the 600.00 daily cap`);
});

test('approving several tickets cannot spend past the cap either', async () => {
  // Each ticket was within budget when queued. Approving them all used to ignore the cap.
  let now = 1_760_000_000_000;
  const { broker, ledger } = makeBroker({ clock: () => { now += 90_000; return now; } });

  const tickets = [];
  for (let i = 0; i < 5; i += 1) {
    const result = await broker.execute({ operation: 'pay_supplier_eur', params: { amount: '250.00' } });
    assert.equal(result.status, 'pending_approval');
    tickets.push(result.approval_id);
  }

  for (const id of tickets) await broker.executeApproved(id);

  const spent = ledger.entries
    .filter(entry => entry.outcome === 'executed')
    .reduce((total, entry) => total + Number(entry.amount), 0);
  assert.ok(spent <= 600, `approved payouts totalling ${spent} must respect the 600.00 cap`);
});

test('asking twice for the same payment produces one ticket, not two', async () => {
  // Two tickets for one request meant approving both paid twice.
  let now = 1_760_000_000_000;
  const { broker } = makeBroker({ clock: () => { now += 90_000; return now; } });
  const first = await broker.execute({ operation: 'pay_supplier_eur', params: { amount: '300.00' } });
  const second = await broker.execute({ operation: 'pay_supplier_eur', params: { amount: '300.00' } });
  assert.equal(first.approval_id, second.approval_id);
  assert.equal(broker.approvals.list().length, 1);
});

test('the approval queue is shared between processes when given a path', () => {
  // The agent runs in the MCP server and the operator in the console: two processes. With an
  // in-memory queue the console never saw the agent's request at all.
  const dir = mkdtempSync(join(tmpdir(), 'guardrail-'));
  try {
    const path = join(dir, 'approvals.json');
    const writer = new ApprovalQueue(path);
    const ticket = writer.enqueue({ operation: 'pay_supplier_eur', params: { amount: '400.00' }, amount: '400.00' });

    const reader = new ApprovalQueue(path);
    assert.equal(reader.list().length, 1, 'a second process must see the pending ticket');
    assert.equal(reader.peek(ticket.id).amount, '400.00');

    reader.take(ticket.id);
    assert.equal(new ApprovalQueue(path).list().length, 0, 'taking it must be visible too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown top-level request field is refused and recorded, not ignored', async () => {
  const { broker, ledger } = makeBroker();
  const result = await broker.execute({
    operation: 'charge_customer_eur',
    params: { amount: '10.00', sku: 'SKU-PRO' },
    url: 'https://collect.attacker.example/v2/checkout/orders'
  });
  assert.equal(result.status, 'request_field_not_allowed');
  const entry = ledger.entries.at(-1);
  assert.equal(entry.outcome, 'bound_override_attempt');
  assert.match(entry.detail, /url/, 'the attempt must leave a trace the operator can read');
});

test('a free-text field rejects a bare domain, an unlabelled IBAN and a homoglyph', () => {
  const doc = policyDoc();
  doc.operations[0].agent.note = {
    path: 'purchase_units[0].description', type: 'text', max_length: 120
  };
  const policy = loadPolicy(doc, ENV);
  const operation = policy.operations.get('charge_customer_eur');
  const rejected = [
    'see attacker.example/refund for details',
    'send it to ES9121000418450200051332',
    'write to bob＠example.com',
    'call +34 600 000 000',
    'visit https://attacker.example',
    'account 1234 5678 9012 3456'
  ];
  for (const note of rejected) {
    assert.throws(
      () => validateParameters(operation, { amount: '10.00', sku: 'SKU-PRO', note }),
      error => error.code === 'parameter_text_forbidden_content',
      `should reject: ${note}`
    );
  }
  // Ordinary prose still works, accents included.
  const accepted = validateParameters(operation, {
    amount: '10.00', sku: 'SKU-PRO', note: 'Reembolso parcial por el incidente del día 4 (25%).'
  });
  assert.ok(accepted.note);
});

test('a money operation whose amount is not counted is refused at load time', () => {
  // Bound constant amount: the ledger recorded null, so no cap and no approval threshold applied.
  const bound = policyDoc();
  bound.operations[1].bound['items[0].amount.value'] = '400.00';
  delete bound.operations[1].agent.amount;
  assert.throws(() => loadPolicy(bound, ENV),
    error => error instanceof PolicyError &&
      ['amount_must_not_be_bound', 'money_operation_needs_decimal_amount'].includes(error.code));

  // A second decimal field: only the first was ever counted.
  const twoAmounts = policyDoc();
  twoAmounts.operations[1].agent.tip = {
    path: 'items[1].amount.value', type: 'decimal', min: '1.00', max: '400.00'
  };
  assert.throws(() => loadPolicy(twoAmounts, ENV),
    error => error.code === 'money_operation_has_multiple_amounts');

  // An amount declared as text skips the numeric checks entirely.
  const textAmount = policyDoc();
  textAmount.operations[1].agent.amount = {
    path: 'items[0].amount.value', type: 'text', max_length: 12
  };
  assert.throws(() => loadPolicy(textAmount, ENV),
    error => ['amount_path_must_be_decimal', 'money_operation_needs_decimal_amount'].includes(error.code));
});

test('a path that is a prefix of another is refused at load time', () => {
  const doc = policyDoc();
  doc.operations[0].agent.whole_amount = {
    path: 'purchase_units[0].amount', type: 'text', max_length: 20
  };
  assert.throws(() => loadPolicy(doc, ENV), error => error.code === 'path_is_prefix_of_another');
});
