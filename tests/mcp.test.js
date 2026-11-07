// SPDX-FileCopyrightText: 2026 Francisco Angulo de Lafuente
// SPDX-License-Identifier: MIT
// Research-Project: PayPal Agentic Guardrail
// Research-Author: Francisco Angulo de Lafuente
// Research-ORCID: https://orcid.org/0009-0001-1634-7063
// Research-Date: 2026-11-07
/**
 * The MCP surface is what a real agent client sees, so it is the actual attack surface. These
 * tests pin down that it exposes two tools and nothing else, and that the refusals reach the
 * client as errors rather than as quietly successful calls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicyFile } from '../src/policy.js';
import { Ledger } from '../src/ledger.js';
import { PaymentOperationBroker } from '../src/broker.js';
import { MockTransport } from '../src/transport.js';
import { createMcpHandler } from '../src/mcp-server.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = {
  OPERATOR_MERCHANT_ID: 'OPERATOR-MERCHANT-0001',
  OPERATOR_SUPPLIER_EMAIL: 'supplier@operator.example'
};
const CREDENTIAL = { clientId: 'TEST-CLIENT-ID-123456', clientSecret: 'TEST-CLIENT-SECRET-abcdef' };

function makeHandler() {
  const policy = loadPolicyFile(resolve(repoRoot, 'policy/operations.json'), ENV);
  const broker = new PaymentOperationBroker({
    policy,
    ledger: new Ledger(null),
    transport: new MockTransport(),
    credentials: { kind: 'test', async resolve() { return CREDENTIAL; } }
  });
  return { handle: createMcpHandler({ broker }), broker };
}

const call = (handle, name, args) => handle({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args }
});

const resultOf = response => JSON.parse(response.result.content[0].text);

test('initialize reports the server', async () => {
  const { handle } = makeHandler();
  const response = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(response.result.serverInfo.name, 'paypal-agentic-guardrail');
  assert.ok(response.result.protocolVersion);
});

test('the whole tool surface is two tools', async () => {
  const { handle } = makeHandler();
  const response = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(
    response.result.tools.map(tool => tool.name).sort(),
    ['list_payment_operations', 'run_payment_operation']
  );
});

test('run_payment_operation accepts no url, header or destination field', async () => {
  const { handle } = makeHandler();
  const response = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const run = response.result.tools.find(tool => tool.name === 'run_payment_operation');
  assert.deepEqual(Object.keys(run.inputSchema.properties).sort(), ['operation', 'params', 'reference']);
  assert.equal(run.inputSchema.additionalProperties, false);
  // The operation name is a closed enum of what the operator declared.
  assert.ok(Array.isArray(run.inputSchema.properties.operation.enum));
  assert.ok(run.inputSchema.properties.operation.enum.includes('charge_customer_eur'));
});

test('the advertised schema leaks no bound value', async () => {
  const { handle } = makeHandler();
  const response = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const serialised = JSON.stringify(response.result.tools);
  assert.ok(!serialised.includes(ENV.OPERATOR_MERCHANT_ID));
  assert.ok(!serialised.includes(ENV.OPERATOR_SUPPLIER_EMAIL));
});

test('a legitimate call executes and returns only the listed fields', async () => {
  const { handle } = makeHandler();
  const response = await call(handle, 'run_payment_operation', {
    operation: 'charge_customer_eur', params: { amount: '49.00', sku: 'SKU-PRO' }
  });
  const result = resultOf(response);
  assert.equal(result.ok, true);
  assert.equal(response.result.isError, false);
  assert.deepEqual(Object.keys(result).sort(), ['amount', 'approve_url', 'currency_code', 'ok', 'order_id', 'status']);
});

test('an injected payee is refused and reported as an error to the client', async () => {
  const { handle } = makeHandler();
  const response = await call(handle, 'run_payment_operation', {
    operation: 'charge_customer_eur', params: { amount: '49.00', sku: 'SKU-PRO', payee: 'ATTACKER' }
  });
  assert.equal(resultOf(response).status, 'parameter_not_allowed');
  assert.equal(response.result.isError, true);
});

test('there is no tool or operation that reveals a credential', async () => {
  const { handle } = makeHandler();
  const refused = await call(handle, 'run_payment_operation', {
    operation: 'reveal_credential', params: {}
  });
  assert.equal(resultOf(refused).status, 'operation_not_allowed');

  const unknownTool = await call(handle, 'enigmagent_resolve', {});
  assert.ok(unknownTool.error, 'an unknown tool must be an error, not a silent success');
});

test('the catalogue tool returns shapes, not bound values', async () => {
  const { handle } = makeHandler();
  const response = await call(handle, 'list_payment_operations', {});
  const text = response.result.content[0].text;
  assert.ok(text.includes('charge_customer_eur'));
  assert.ok(!text.includes(ENV.OPERATOR_MERCHANT_ID));
});
