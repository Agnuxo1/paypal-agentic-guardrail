# PayPal Sandbox acceptance check — 8 November 2026

Francisco Angulo de Lafuente · [ORCID 0009-0001-1634-7063](https://orcid.org/0009-0001-1634-7063) · MIT License

A separate authenticated Sandbox check created a EUR1 order (HTTP201, CREATED) and read the same order (HTTP200, CREATED). Both response shapes and the matching internal identifier passed validation. The check used the reviewed broker at commit `6957d117881d11d308a9306dad5a14a2dd7ebf0d`. No checkout approval, capture, refund, payout or model call was attempted.

This is participant technical acceptance evidence for create/read, separate from the retained offline benchmark. It does not validate all six operations, production security, an official submission or a competition score. The 2:35 video shows the captured offline executions; it does not show this later Sandbox run. The real-model experiment was not rerun.

The check imported the existing broker and fixed operator policy. The temporary handoff supplied credentials through the broker's `resolve()` interface in memory, rather than a file, vault or environment variable. An independently reviewed loopback form replaced unavailable native-console input. Twelve offline adapter checks passed, followed by a real-browser mock check. A deadline defect found in independent review was repaired and its closure independently checked before real credentials were used. Credentials, raw headers/bodies and merchant/order identifiers are omitted. Local variable references and the clipboard were cleared after use. JavaScript strings cannot be reliably overwritten; the dedicated handoff process exits after completion or expiry.

## Sanitized receipt

```json
{
  "mode": "sandbox",
  "host": "api-m.sandbox.paypal.com",
  "actual_network": true,
  "sandbox_verified": true,
  "acceptance_check_passed": true,
  "operations": [
    "charge_customer_eur",
    "show_order"
  ],
  "requested_amount": "1.00",
  "currency": "EUR",
  "capture_attempted": false,
  "payout_attempted": false,
  "model_called": false,
  "credentials_persisted": false,
  "result_statuses": [
    "executed",
    "executed"
  ],
  "exchanges": [
    {
      "method": "POST",
      "route": "/v2/checkout/orders",
      "http_status": 201,
      "response_state": "CREATED",
      "response_type": "unavailable",
      "response_shape_valid": true
    },
    {
      "method": "GET",
      "route": "/v2/checkout/orders/:redacted_id",
      "http_status": 200,
      "response_state": "CREATED",
      "response_type": "unavailable",
      "response_shape_valid": true
    }
  ],
  "scope": "Participant technical create/read check only; not all6 operations, financial safety, official entry or competition score.",
  "started_at_utc": "2026-11-08T20:23:28.901Z",
  "finished_at_utc": "2026-11-08T20:26:36.328Z",
  "source_commit": "6957d117881d11d308a9306dad5a14a2dd7ebf0d",
  "helper_sha256": "925a4477a58f72af3015c1d04bed552554db97b20cf3098432eba53aad063b7a",
  "adapter_sha256": "e6b973c3c4a080bccefd3011438d1afff0f83b984d5997327b47fb0d2d8739cd",
  "credential_handoff": "loopback form to ephemeral credential-source memory; no env or credential file"
}
```

The source commit remains the baseline for the measured code. This evidence-only addition does not change the broker, policy, retained experiments or video. Preserve third-party notices and the author's attribution when reproducing this work.
