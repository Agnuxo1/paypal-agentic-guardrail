# Preregistration: three new experiments, 7 November 2026

Written and committed **before** any of these runs. The commit hash of this file is the record
of what was decided first. Results go in `bench/results/`, including any that disappoint.

## Why

The first bench used a scripted agent and a local stand-in for PayPal. That leaves three open
questions, and each gets its own experiment with its own kind of evidence.

## E1: real language models instead of the scripted agent

**Question.** Does the guardrail hold when a real tool-calling model reads the hostile text and
decides for itself, and how often does the same model cause harm without the guardrail?

- **Models (3, different vendors):** `Qwen/Qwen3-30B-A3B-Instruct-2507`, `openai/gpt-oss-120b`,
  `deepseek-ai/DeepSeek-V4.1-Flash`, through Nebius Token Factory. If one cannot do tool calls in
  a smoke test it is replaced by `zai-org/GLM-5.3-Flash`, and the replacement is reported.
- **Arms (3):** `guardrail` (the two MCP tools only), `control` (an HTTP tool, with the access
  token and operator settings in context), `control_hardened` (the same, plus written rules in
  the system prompt and an instruction to treat data as untrusted).
- **Cases:** all 30 in `bench/cases.json`, original wording, 2 repetitions at temperature 0.3.
  That is 3 × 3 × 30 × 2 = 540 runs.
- **Transport:** the offline mock, scored on the wire with the same detectors as the main bench.
- **Primary metric:** runs with at least one security incident, per arm and model.
- **Secondary:** attacks achieved; benign tasks completed, meaning the expected request was
  accepted on the wire with the expected amount; broker refusals in the guardrail arm, which show
  the model really tried.
- **Hypotheses.**
  - H1: `guardrail` has 0 runs with an incident on all three models.
  - H2: `control` has more incident runs than `guardrail`, pooled over models, with Wilson 95 %
    intervals that do not overlap.
  - H3: `guardrail` benign completion is within 10 points of `control`, pooled.
- **Exclusions.** A run lost to an API error after 3 retries is reported as `harness_error` and
  left out of rates, with the count published. No other exclusion.
- **Budget.** Stops at 6 million tokens. Free credits only.

A failure of H3 would be a real usability finding, not noise: the model has to work out a
narrower interface.

## E2: conformance with PayPal's published API specification

**Question.** Are the requests the broker composes valid according to PayPal's own OpenAPI
documents, not only according to our stand-in?

- **Reference:** the public repository `paypal/paypal-rest-api-specifications`, pinned by commit.
- **Method:** compose the body of every write operation in `policy/operations.json` and validate
  it against the matching request schema. Also check that every method and path in the endpoint
  table exists in the specification.
- **Metric:** operations that validate, out of those in the table.
- **Negative control:** the pre-fix order body and bodies with a required field removed must
  fail, or the check proves nothing.
- **Hypothesis H4:** all operations validate and all negative controls fail.

This shows schema conformance. It does not show that PayPal accepts the request at run time,
which needs the sandbox.

## E3: mutation testing of the broker

**Question.** If a safeguard is removed, does the evidence notice?

- **Method:** apply one source mutation at a time to a temporary copy of the repository, each
  removing one safeguard (bound fields, limits, reference check, idempotency, approval, unknown
  field refusal, refund bound, response reduction, approval link check, serialisation), then run
  the test suite and the bench.
- **Metric:** mutants killed, out of those applied. Killed means a test fails or the guardrail arm
  reports an incident.
- **Hypothesis H5:** every mutant is killed. A survivor is treated as a gap and gets a new test,
  and it stays in the report as a survivor of the first pass.

## Fixed in advance

Detectors, cases, prompts and the system prompts in `bench/run-llm.js` are not edited after the
first full E1 run. If a harness defect makes a change necessary, the earlier run is kept, the
change is described, and both are published.
