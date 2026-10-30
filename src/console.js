/**
 * The operator console.
 *
 * This is the half of the product a person uses. It is deliberately not an admin panel for the
 * agent: there is no button here that lets the agent do more. It shows what the policy binds,
 * what the agent did, what is waiting for a human, and whether the audit chain is intact.
 *
 * It binds to loopback only. Approving a payment is an operator action, so the console is not
 * something to expose.
 */

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const MAX_BODY = 64 * 1024;

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

function safeEqual(a, b) {
  const left = digest(a);
  const right = digest(b);
  return timingSafeEqual(left, right);
}

/**
 * The operator console needs a token even on loopback: anything running on the same machine,
 * including the agent itself, can reach a loopback port.
 */
export function createConsoleServer({ broker, policy, token = randomBytes(24).toString('base64url') }) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');

    if (request.method === 'GET' && url.pathname === '/') {
      return send(response, 200, 'text/html; charset=utf-8', page(token));
    }

    // Everything else is API and needs the token.
    const header = /^Bearer (.+)$/.exec(request.headers.authorization ?? '');
    if (!header || !safeEqual(header[1], token)) {
      return send(response, 401, 'application/json', JSON.stringify({ error: 'unauthorized' }));
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      const verdict = broker.ledger.verify();
      return json(response, 200, {
        environment: policy.environment,
        operations: policy.catalogue,
        bound_fields: policy.operations ? boundSummary(policy) : [],
        ledger: broker.ledger.entries.slice(-200),
        ledger_chain: verdict,
        incidents: broker.ledger.incidents,
        blocked_attempts: broker.ledger.blockedAttempts,
        approvals: broker.approvals.list()
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/approve') {
      return readBody(request, response, async body => {
        const result = await broker.executeApproved(body.approval_id);
        json(response, 200, { result: { ...result } });
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/reject') {
      return readBody(request, response, async body => {
        const removed = broker.approvals.reject(body.approval_id);
        json(response, 200, { rejected: removed });
      });
    }

    return json(response, 404, { error: 'not_found' });
  });

  return { server, token };
}

/**
 * What the operator bound, per operation. Values are shown to the operator — they are the
 * operator's own configuration — but this is never sent to the agent, which sees only
 * `policy.catalogue`.
 */
function boundSummary(policy) {
  return [...policy.operations.values()].map(operation => ({
    name: operation.name,
    api: operation.api,
    method: operation.endpoint.method,
    path: operation.endpoint.path,
    bound: operation.bound.map(entry => ({ path: entry.path.join('.'), value: String(entry.value) })),
    derived: operation.derived.map(entry => ({ path: entry.path.join('.'), source: entry.source })),
    agent: operation.agent.map(field => ({
      name: field.name,
      type: field.type,
      range: field.type === 'decimal' || field.type === 'integer'
        ? `${field.min} … ${field.max}`
        : field.type === 'enum' ? field.values.join(', ') : `≤ ${field.maxLength} chars`
    })),
    limits: operation.limits,
    approval: operation.approval
  }));
}

function readBody(request, response, handler) {
  const chunks = [];
  let size = 0;
  request.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY) {
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', async () => {
    try {
      await handler(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    } catch (error) {
      json(response, 400, { error: 'bad_request', detail: error.message });
    }
  });
}

function send(response, status, type, body) {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // `connect-src 'self'` is required: without it `default-src 'none'` blocks the page's own
    // fetch to /api/state and the console renders empty.
    'content-security-policy': "default-src 'none'; connect-src 'self'; " +
      "style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; " +
      "base-uri 'none'; frame-ancestors 'none'"
  });
  response.end(body);
}

function json(response, status, body) {
  send(response, status, 'application/json', JSON.stringify(body));
}

function page(token) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment Guardrail</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --panel: #ffffff; --ink: #14181f; --muted: #5c6672;
    --line: #dfe3e8; --ok: #0a7d4e; --warn: #9a5b00; --bad: #b3261e; --accent: #1f3a8a;
    --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #11141a; --panel: #181c24; --ink: #e8ebf0; --muted: #9aa4b2;
      --line: #2a3240; --ok: #4ad295; --warn: #e0a955; --bad: #ff8a80; --accent: #8ab4ff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--ink);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); margin: 0 0 24px; font-size: 13px; }
  .panel {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 16px 18px; margin-bottom: 18px;
  }
  .panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); margin: 0 0 12px; font-weight: 600; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  .chip {
    font: 12px/1 var(--mono); padding: 5px 9px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--muted);
  }
  .chip.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .chip.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 40%, var(--line)); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line);
    vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.05em; }
  td.mono, .mono { font-family: var(--mono); font-size: 12px; }
  .bound { color: var(--accent); }
  .agentfield { color: var(--warn); }
  .outcome-executed { color: var(--ok); }
  .outcome-refused, .outcome-replay_suppressed, .outcome-pending_approval { color: var(--warn); }
  .outcome-bound_override_attempt, .outcome-policy_mutation_attempt,
  .outcome-credential_exposed, .outcome-destination_not_in_table { color: var(--bad); }
  button {
    font: inherit; padding: 6px 12px; border-radius: 7px; border: 1px solid var(--line);
    background: var(--panel); color: var(--ink); cursor: pointer;
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .empty { color: var(--muted); font-size: 13px; padding: 6px 0; }
  details summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  @media (max-width: 640px) {
    body { padding: 16px; }
    /* Long bound paths and ids overflow a phone's width; let each table scroll on its own
       rather than pushing the page sideways. */
    table { font-size: 12px; display: block; overflow-x: auto; }
    th, td { white-space: nowrap; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>Payment Guardrail — operator console</h1>
  <p class="sub">What the agent may do, what it did, and what is waiting for you.</p>

  <div class="panel">
    <h2>Status</h2>
    <div class="row" id="status"></div>
  </div>

  <div class="panel">
    <h2>Waiting for your approval</h2>
    <div id="approvals"></div>
  </div>

  <div class="panel">
    <h2>Operations the agent may name</h2>
    <p class="sub" style="margin:-4px 0 12px">
      <span class="bound">Blue</span> is bound by you and the agent cannot touch it.
      <span class="agentfield">Amber</span> is the agent's only freedom, inside that range.
    </p>
    <div id="operations"></div>
  </div>

  <div class="panel">
    <h2>Audit ledger</h2>
    <div id="ledger"></div>
  </div>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
const esc = value => String(value ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }
  });
  return response.json();
}

function renderStatus(state) {
  const chain = state.ledger_chain.ok;
  const incidents = state.incidents.length;
  document.getElementById('status').innerHTML = [
    '<span class="chip">environment: ' + esc(state.environment) + '</span>',
    '<span class="chip">operations: ' + state.operations.length + '</span>',
    '<span class="chip">ledger entries: ' + state.ledger.length + '</span>',
    '<span class="chip ' + (chain ? 'ok' : 'bad') + '">audit chain: ' +
      (chain ? 'intact' : 'BROKEN at #' + state.ledger_chain.brokenAt) + '</span>',
    '<span class="chip ' + (incidents === 0 ? 'ok' : 'bad') + '">security incidents: ' +
      incidents + '</span>',
    '<span class="chip">attempts blocked: ' + state.blocked_attempts.length + '</span>'
  ].join('');
}

function renderApprovals(state) {
  const node = document.getElementById('approvals');
  if (state.approvals.length === 0) {
    node.innerHTML = '<p class="empty">Nothing waiting. Payments above your thresholds appear here.</p>';
    return;
  }
  node.innerHTML = '<table><thead><tr><th>ticket</th><th>operation</th><th>amount</th>' +
    '<th>requested</th><th></th></tr></thead><tbody>' +
    state.approvals.map(ticket =>
      '<tr><td class="mono">' + esc(ticket.id) + '</td><td class="mono">' + esc(ticket.operation) +
      '</td><td class="mono">' + esc(ticket.amount ?? '—') + '</td><td class="mono">' +
      esc(ticket.at) + '</td><td><button class="primary" data-approve="' + esc(ticket.id) +
      '">Approve</button> <button data-reject="' + esc(ticket.id) + '">Reject</button></td></tr>'
    ).join('') + '</tbody></table>';
}

function renderOperations(state) {
  document.getElementById('operations').innerHTML = state.bound_fields.map(operation =>
    '<details open><summary><strong class="mono">' + esc(operation.name) + '</strong> — ' +
    esc(operation.method) + ' ' + esc(operation.path) + '</summary>' +
    '<table><tbody>' +
    operation.bound.map(entry => '<tr><td class="mono bound">bound</td><td class="mono">' +
      esc(entry.path) + '</td><td class="mono">' + esc(entry.value) + '</td></tr>').join('') +
    operation.derived.map(entry => '<tr><td class="mono">derived</td><td class="mono">' +
      esc(entry.path) + '</td><td class="mono">' + esc(entry.source) + '</td></tr>').join('') +
    operation.agent.map(field => '<tr><td class="mono agentfield">agent</td><td class="mono">' +
      esc(field.name) + '</td><td class="mono">' + esc(field.range) + '</td></tr>').join('') +
    '<tr><td class="mono">limits</td><td class="mono" colspan="2">per call ' +
      esc(operation.limits.perCallMax ?? '—') + ' · daily ' +
      esc(operation.limits.dailyTotalMax ?? '—') + ' · ' +
      esc(operation.limits.maxCallsPerHour ?? '—') + '/h · approval ' +
      esc(operation.approval) + '</td></tr>' +
    '</tbody></table></details>'
  ).join('');
}

function renderLedger(state) {
  const node = document.getElementById('ledger');
  if (state.ledger.length === 0) {
    node.innerHTML = '<p class="empty">No activity yet. Run the demo to populate this.</p>';
    return;
  }
  node.innerHTML = '<table><thead><tr><th>#</th><th>when</th><th>operation</th><th>outcome</th>' +
    '<th>amount</th><th>reference</th><th>detail</th></tr></thead><tbody>' +
    state.ledger.slice().reverse().map(entry =>
      '<tr><td class="mono">' + entry.seq + '</td><td class="mono">' +
      esc(entry.at.slice(11, 19)) + '</td><td class="mono">' + esc(entry.operation) +
      '</td><td class="mono outcome-' + esc(entry.outcome) + '">' + esc(entry.outcome) +
      '</td><td class="mono">' + esc(entry.amount ?? '—') + '</td><td class="mono">' +
      esc(entry.reference ?? '—') + '</td><td class="mono">' + esc(entry.detail ?? '') +
      '</td></tr>'
    ).join('') + '</tbody></table>';
}

async function refresh() {
  const state = await api('/api/state');
  renderStatus(state);
  renderApprovals(state);
  renderOperations(state);
  renderLedger(state);
}

document.addEventListener('click', async event => {
  const approve = event.target.getAttribute('data-approve');
  const reject = event.target.getAttribute('data-reject');
  if (approve) {
    await api('/api/approve', { method: 'POST', body: JSON.stringify({ approval_id: approve }) });
    refresh();
  } else if (reject) {
    await api('/api/reject', { method: 'POST', body: JSON.stringify({ approval_id: reject }) });
    refresh();
  }
});

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}
