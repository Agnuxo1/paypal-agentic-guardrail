#!/usr/bin/env node
/**
 * guardrail — one entry point for everything a person runs.
 *
 *   guardrail demo            seed a realistic session and print what the agent could and could not do
 *   guardrail console         start the operator console on loopback
 *   guardrail serve           run the MCP server on stdio, for a real agent client
 *   guardrail policy-check    validate the operator policy and print what each operation allows
 *   guardrail vault-init      put PayPal sandbox credentials into an encrypted EnigmAgent vault
 *   guardrail ledger-verify   check the audit chain of a ledger file
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { loadPolicyFile } from './policy.js';
import { Ledger } from './ledger.js';
import { PaymentOperationBroker } from './broker.js';
import { createCredentialSource, initialiseVault, PAYPAL_SANDBOX_DOMAIN } from './credentials.js';
import { HttpsTransport, MockTransport } from './transport.js';
import { createConsoleServer } from './console.js';
import { serveStdio } from './mcp-server.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function env() {
  return {
    ...process.env,
    OPERATOR_MERCHANT_ID: process.env.OPERATOR_MERCHANT_ID ?? 'OPERATOR-MERCHANT-0001',
    OPERATOR_SUPPLIER_EMAIL: process.env.OPERATOR_SUPPLIER_EMAIL ?? 'supplier@operator.example'
  };
}

function loadPolicy() {
  const path = process.env.GUARDRAIL_POLICY ?? resolve(repoRoot, 'policy/operations.json');
  return { policy: loadPolicyFile(path, env()), path };
}

/**
 * The mock transport is the default so the project runs with no PayPal account at all. Set
 * GUARDRAIL_TRANSPORT=sandbox once real sandbox credentials are in place.
 */
function buildTransport(policy) {
  const mode = process.env.GUARDRAIL_TRANSPORT ?? 'mock';
  if (mode === 'sandbox') return new HttpsTransport(policy.environment);
  if (mode !== 'mock') throw new Error(`unknown GUARDRAIL_TRANSPORT: ${mode}`);
  return new MockTransport();
}

function buildBroker() {
  const { policy, path } = loadPolicy();
  const transport = buildTransport(policy);
  const credentials = createCredentialSource(process.env);
  const ledgerPath = process.env.GUARDRAIL_LEDGER ?? null;
  const ledger = new Ledger(ledgerPath);
  const broker = new PaymentOperationBroker({ policy, transport, credentials, ledger });
  return { broker, policy, transport, credentials, policyPath: path, ledgerPath };
}

function banner({ policy, transport, credentials, policyPath }) {
  const lines = [
    `policy      ${policyPath} (${policy.operations.size} operations, ${policy.environment})`,
    `transport   ${transport.kind} -> ${transport.host}`,
    `credentials ${credentials.kind}: ${credentials.description}`
  ];
  if (credentials.kind === 'env') {
    lines.push('            note: the credential sits in this process environment. A vault ' +
      '(guardrail vault-init) binds it to the PayPal host instead.');
  }
  if (transport.kind === 'mock') {
    lines.push('            note: offline mock. Nothing reaches PayPal. ' +
      'Set GUARDRAIL_TRANSPORT=sandbox for the real sandbox.');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * A scripted session that shows the product doing its job and refusing the things it should.
 * Every line printed is a real broker call against the configured transport.
 */
async function demo() {
  const context = buildBroker();
  const { broker } = context;
  process.stdout.write(banner(context));

  const steps = [
    {
      title: 'The agent charges the customer for the plan they chose',
      request: { operation: 'charge_customer_eur', params: { amount: '49.00', sku: 'SKU-PRO' } }
    },
    {
      title: 'and captures it',
      request: { operation: 'capture_order', params: {} },
      useReference: 'order_id'
    },
    {
      title: 'A product description tells it to pay a different merchant',
      note: 'the broker interface has no payee field, so the attempt has nowhere to go',
      request: {
        operation: 'charge_customer_eur',
        params: { amount: '49.00', sku: 'SKU-PRO', payee: 'RESELLER77Q' }
      }
    },
    {
      title: 'An invoice note asks for 9999.00 instead of the listed price',
      note: 'the operator declared 1.00 … 250.00',
      request: { operation: 'charge_customer_eur', params: { amount: '9999.00', sku: 'SKU-PRO' } }
    },
    {
      title: 'The customer insists the charge did not register and asks to run it again',
      note: 'the idempotency key is derived by the broker, so the second one is suppressed',
      request: { operation: 'charge_customer_eur', params: { amount: '49.00', sku: 'SKU-PRO' } }
    },
    {
      title: 'Something asks the agent to reveal the client secret',
      note: 'there is no such operation in the catalogue',
      request: { operation: 'reveal_credential', params: {} }
    },
    {
      title: 'A supplier payout of 400.00 EUR',
      note: 'above the operator approval threshold, so it waits for a person',
      request: { operation: 'pay_supplier_eur', params: { amount: '400.00' } }
    },
    {
      title: 'A supplier payout of 120.00 EUR',
      note: 'under the threshold, so it goes straight through to the bound receiver',
      request: { operation: 'pay_supplier_eur', params: { amount: '120.00' } }
    }
  ];

  const issued = {};
  for (const step of steps) {
    const request = { ...step.request };
    if (step.useReference) request.reference = issued[step.useReference];
    const result = await broker.execute(request);
    for (const key of ['order_id', 'capture_id', 'refund_id', 'payout_batch_id']) {
      if (result[key]) issued[key] = result[key];
    }
    const verdict = result.ok ? 'OK ' : '-- ';
    process.stdout.write(`\n${verdict}${step.title}\n`);
    if (step.note) process.stdout.write(`    ${step.note}\n`);
    process.stdout.write(`    request  ${JSON.stringify(request)}\n`);
    process.stdout.write(`    result   ${JSON.stringify({ ...result })}\n`);
  }

  const chain = broker.ledger.verify();
  process.stdout.write([
    '',
    `ledger: ${broker.ledger.entries.length} entries, chain ${chain.ok ? 'intact' : `BROKEN at ${chain.brokenAt}`}`,
    `security incidents: ${broker.ledger.incidents.length}`,
    `attempts blocked: ${broker.ledger.blockedAttempts.length}`,
    `waiting for a human: ${broker.approvals.list().length}`,
    '',
    'Outcomes recorded:',
    ...broker.ledger.entries.map(entry =>
      `  #${String(entry.seq).padStart(2)} ${entry.operation.padEnd(22)} ${entry.outcome}` +
      `${entry.detail ? ` (${entry.detail})` : ''}`),
    ''
  ].join('\n'));
}

async function startConsole() {
  const context = buildBroker();
  process.stdout.write(banner(context));
  const port = Number(process.env.GUARDRAIL_CONSOLE_PORT ?? 7788);
  // Loopback by default. Inside a container the host port mapping cannot reach the container's
  // own loopback, so docker-compose sets 0.0.0.0 and publishes to the host's loopback only.
  const bind = process.env.GUARDRAIL_CONSOLE_BIND ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(bind)) {
    throw new Error(`GUARDRAIL_CONSOLE_BIND must be 127.0.0.1 or 0.0.0.0, got: ${bind}`);
  }
  const { server, token } = createConsoleServer({
    broker: context.broker,
    policy: context.policy,
    token: process.env.GUARDRAIL_CONSOLE_TOKEN
  });
  server.listen(port, bind, () => {
    process.stdout.write(`\noperator console: http://127.0.0.1:${port}/\n`);
    if (!process.env.GUARDRAIL_CONSOLE_TOKEN) {
      process.stdout.write(`session token (regenerated each start): ${token}\n`);
    }
    process.stdout.write(bind === '0.0.0.0'
      ? 'bound to 0.0.0.0 inside this container; the token is required for every API call.\n'
      : 'loopback only; the token is required for every API call.\n');
  });
}

function policyCheck() {
  const { policy, path } = loadPolicy();
  process.stdout.write(`policy ${path}\nenvironment ${policy.environment}\n\n`);
  for (const operation of policy.operations.values()) {
    process.stdout.write(`${operation.name}  ->  ${operation.endpoint.method} ${operation.endpoint.path}\n`);
    for (const entry of operation.bound) {
      process.stdout.write(`  bound    ${entry.path.join('.')} = ${entry.value}\n`);
    }
    for (const entry of operation.derived) {
      process.stdout.write(`  derived  ${entry.path.join('.')} <- ${entry.source}\n`);
    }
    for (const field of operation.agent) {
      const range = field.type === 'decimal' || field.type === 'integer'
        ? `${field.min} … ${field.max}`
        : field.type === 'enum' ? field.values.join(' | ') : `text ≤ ${field.maxLength}`;
      process.stdout.write(`  agent    ${field.name}: ${range}\n`);
    }
    process.stdout.write(`  limits   per call ${operation.limits.perCallMax ?? '—'}` +
      ` · daily ${operation.limits.dailyTotalMax ?? '—'}` +
      ` · ${operation.limits.maxCallsPerHour ?? '—'}/h · approval ${operation.approval}\n`);
    process.stdout.write(`  returns  ${operation.response.join(', ')}\n\n`);
  }
  process.stdout.write('policy is valid.\n');
}

function ask(question, { silent = false } = {}) {
  return new Promise(resolvePromise => {
    const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (silent) {
      // Keep the secret off the terminal and out of the scrollback.
      lines.output.write(question);
      lines._writeToOutput = () => {};
    }
    lines.question(silent ? '' : question, answer => {
      if (silent) lines.output.write('\n');
      lines.close();
      resolvePromise(answer.trim());
    });
  });
}

async function vaultInit() {
  const vaultPath = process.env.GUARDRAIL_VAULT ?? './paypal.vault.json';
  process.stdout.write([
    'This writes your PayPal SANDBOX credentials into an encrypted EnigmAgent vault',
    `(${vaultPath}), each entry bound to ${PAYPAL_SANDBOX_DOMAIN}, so it cannot be resolved`,
    'for any other destination. Nothing is printed back.',
    '',
    'Get sandbox credentials at https://developer.paypal.com/ -> Apps & Credentials -> Sandbox.',
    'Never put live credentials here.',
    ''
  ].join('\n'));

  const username = await ask('vault user name: ');
  const password = await ask('vault password: ', { silent: true });
  const clientId = await ask('PayPal sandbox client id: ', { silent: true });
  const clientSecret = await ask('PayPal sandbox client secret: ', { silent: true });

  if (!username || !password || !clientId || !clientSecret) {
    process.stderr.write('all four values are required; nothing was written.\n');
    process.exitCode = 1;
    return;
  }

  const created = await initialiseVault({ vaultPath, username, password, clientId, clientSecret });
  process.stdout.write([
    '',
    `vault created: ${created.vaultPath}`,
    `entries: ${created.entries.join(', ')} (bound to ${created.domain})`,
    '',
    'Now set, in your environment or .env:',
    `  GUARDRAIL_CREDENTIALS=vault`,
    `  GUARDRAIL_VAULT=${created.vaultPath}`,
    `  GUARDRAIL_VAULT_USER=${username}`,
    '  GUARDRAIL_VAULT_PASSWORD=<the password you just chose>',
    '  GUARDRAIL_TRANSPORT=sandbox',
    ''
  ].join('\n'));
}

function ledgerVerify() {
  const path = process.argv[3] ?? process.env.GUARDRAIL_LEDGER;
  if (!path) {
    process.stderr.write('usage: guardrail ledger-verify <ledger.jsonl>\n');
    process.exitCode = 1;
    return;
  }
  const ledger = new Ledger(path);
  const verdict = ledger.verify();
  process.stdout.write([
    `ledger ${path}`,
    `entries ${ledger.entries.length}`,
    `chain ${verdict.ok ? 'intact' : `BROKEN at #${verdict.brokenAt} (${verdict.reason})`}`,
    `security incidents ${ledger.incidents.length}`,
    ''
  ].join('\n'));
  if (!verdict.ok) process.exitCode = 1;
}

async function main() {
  const command = process.argv[2] ?? 'demo';
  switch (command) {
    case 'demo': return demo();
    case 'console': return startConsole();
    case 'serve': {
      const { broker } = buildBroker();
      return serveStdio({ broker });
    }
    case 'policy-check': return policyCheck();
    case 'vault-init': return vaultInit();
    case 'ledger-verify': return ledgerVerify();
    case '--help':
    case 'help':
      process.stdout.write(readFileSync(new URL(import.meta.url)).toString()
        .split('\n').slice(1, 12).map(line => line.replace(/^ \* ?/, '')).join('\n'));
      process.stdout.write('\n');
      return undefined;
    default:
      process.stderr.write(`unknown command: ${command}\nTry: guardrail help\n`);
      process.exitCode = 1;
      return undefined;
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
