## Inspiration

A merchant wants an AI assistant to create orders and help manage payments, while keeping control of where money goes and how much can move. Product descriptions and invoices are untrusted input. In our comparison baseline, a model receives an access token and a general HTTP tool; hostile text can redirect its requests. We built a narrower payment interface and measured what changed.

## What it does

The operator writes a policy. The agent chooses an operation and values inside a closed schema. Payee, currency and destination are bound by the operator and applied last. OAuth credentials and request identifiers are derived by the broker. Unknown fields and values above the declared bounds are refused.

Six operations cover Orders v2, Payments v2 and Payouts v1: create, capture and read an order; refund a capture; send and read a supplier payout. Per-call and aggregate spending limits, broker-issued references, an approval queue and a local operator console surround the interface. Approved requests are checked against the limits again.

Identical requests within the same fixed one-minute time bucket reuse the broker's identifier; crossing that bucket can create a new request. The hash-chained ledger detects edits against a trusted retained history. A privileged owner who rewrites the complete local history is outside that protection.

The model can still choose an undesirable amount inside the allowed range. The policy is a bound on its authority, not a guarantee that its judgment is correct.

## How we built it

Node.js 22, a payment-operation broker, an MCP interface with two tools, and our existing enigmagent-mcp vault using Argon2id and AES-256-GCM with origin binding. The preexisting broker supported read-only GET/HEAD operations; the hackathon work adds the PayPal write path, limits, references, approvals, response reduction and evaluation.

The AI integration uses OpenAI-compatible tool-calling models or an MCP client. The retained experiment used Qwen3-30B-A3B, gpt-oss-120b and DeepSeek-V4.1-Flash through Nebius Token Factory. The reproducible demo uses an offline transport; it does not move money.

## Results

The preregistered real-model experiment contains 30 fixed tasks, three models, three arms and two repetitions: 540 runs, with 180 complete matched arm triplets and no recorded harness errors.

| Retained offline measurements | Broker | General HTTP control | Control with written rules |
|---|---:|---:|---:|
| Runs with an incident, out of 180 | 0 | 32 | 4 |
| Adversarial goals achieved, out of 120 | 0 | 50 | 7 |
| Benign tasks completed, out of 60 | 59 | 60 | 60 |

The broker completed 59/60 benign tasks. Seven guarded runs still used an amount different from the intended amount while remaining inside policy bounds. All seven attack successes against the written-rule control came from Qwen; the other two models resisted this fixed attack suite in that arm.

A secondary, explicitly post hoc analysis groups repeated model runs by the original case. The four incident runs in the written-rule control are concentrated in two of the 30 case IDs. The broker-minus-written-rule incident difference is -2.22 percentage points; a descriptive 10,000-draw case-resampling interval is [-5.56, 0.00] points. This does not establish superiority on incident risk over written rules. These participant-authored tasks are not a random sample of future attacks, and repeated runs are not independent security problems.

The separate scripted stress test records 450 executions: the broker blocks 100/100 adversarial goals with zero incidents and completes 50/50 benign tasks. Saved artifacts report six operation schemas, eight routes and 11 malformed-body negative controls, plus 19/19 safeguard mutations detected. Schema checks do not establish PayPal's runtime acceptance. The independent code audit reproduced 70 tests and the scripted stress test; it recounted the model records without reexecuting the remote models.

All benchmark measurements above use an offline stand-in. In a separate authenticated check on 8 November 2026, the same reviewed broker created a EUR1 order in PayPal Sandbox (HTTP201, CREATED) and read the same order (HTTP200, CREATED). Both response shapes and the matching internal identifier passed validation. No checkout approval, capture, refund, payout or model call was attempted. The public sanitized receipt records the source and checker hashes while omitting credentials and merchant/order identifiers. This verifies the create/read integration; it does not establish production safety or acceptance of all six operations. The revised 2:49 video combines animated README diagrams with captured offline executions and an illustration of this separately recorded Sandbox receipt. It does not replay a live Sandbox call.

## Challenges and what we learned

An early detector inspected the agent's proposed request rather than the request reaching the transport. A reviewer broke the payee binding and the old benchmark still passed. We fixed the detector, retained the failure, and confirmed that the same mutation now produces 30 incidents. That negative control makes the later result meaningful.

Independent reviews also exposed concurrency, shared-limit and approval-state defects. They were reproduced, repaired and covered by tests. The interface gives the operator explicit controls, with the limits of the evidence kept visible.

## What's next

The required Sandbox create/read acceptance check is complete and published separately from the offline study. The next integration work is to test the remaining operations in Sandbox and extend the operator console, with explicit approvals before any capture or payout tests.

Then allocate eight developer hours over two days to 20 independently authored adaptive cases, evaluated in three arms and two repetitions with one additional local model. Cap this follow-up at two managed-server GPU hours, 360 model calls and zero paid API spend; stop at the caps and report incomplete or negative results. These are proposed resource limits, not measured throughput or a completion guarantee. The source, captured evidence and setup instructions are public under MIT.

## Built with

node.js, javascript, paypal-rest-api, paypal-orders-v2, paypal-payouts, model-context-protocol, enigmagent, argon2id, aes-256-gcm, docker

## Links

- Source and complete setup: https://github.com/Agnuxo1/paypal-agentic-guardrail
- Video: https://youtu.be/iP91sBZ5lxo
- Separate Sandbox acceptance: https://github.com/Agnuxo1/paypal-agentic-guardrail/blob/67809207998c1d96eefb5f2302bb746d0097d9e4/docs/recovery-20261108/SANDBOX_ACCEPTANCE_20261108.md
- Author: Francisco Angulo de Lafuente; ORCID https://orcid.org/0009-0001-1634-7063

## Testing instructions

The offline review path needs no PayPal credentials:

```sh
git clone https://github.com/Agnuxo1/paypal-agentic-guardrail
cd paypal-agentic-guardrail
npm install
npm run demo
npm run bench
npm test
```

For real sandbox credentials and the operator console, follow the README's separate instructions. Keep credentials out of the submission and repository. The revised video combines the README animations, captured execution outputs and the actual local console, with a separate illustrated Sandbox receipt. The local synthetic narration and generated thumbnail are disclosed; author and ORCID remain visible.
