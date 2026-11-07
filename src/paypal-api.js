// SPDX-FileCopyrightText: 2026 Francisco Angulo de Lafuente
// SPDX-License-Identifier: MIT
// Research-Project: PayPal Agentic Guardrail
// Research-Author: Francisco Angulo de Lafuente
// Research-ORCID: https://orcid.org/0009-0001-1634-7063
// Research-Date: 2026-11-07
/**
 * The fixed PayPal endpoint table.
 *
 * This table is the only place a destination can come from. An operation in the operator
 * policy names a key here; nothing in the agent's request can introduce a host, a path or a
 * method. Every entry was taken from the official reference:
 *   https://developer.paypal.com/api/orders/v2
 *   https://developer.paypal.com/api/payments/v2
 *   https://developer.paypal.com/api/payments.payouts-batch/v1
 *   https://developer.paypal.com/api/rest/   (token endpoint and sandbox host)
 */

export const PAYPAL_HOSTS = Object.freeze({
  sandbox: 'api-m.sandbox.paypal.com',
  live: 'api-m.paypal.com'
});

export const TOKEN_ENDPOINT = Object.freeze({
  method: 'POST',
  path: '/v1/oauth2/token',
  grant: 'grant_type=client_credentials'
});

/**
 * `path` may contain one `{…}` placeholder. The placeholder is filled from a reference the
 * broker itself issued earlier (an order id or capture id it recorded in the ledger), never
 * from a free-text value the agent supplies. See `resolveReference` in broker.js.
 */
export const ENDPOINTS = Object.freeze({
  'orders_v2.create': Object.freeze({
    method: 'POST', path: '/v2/checkout/orders', writes: true, reference: null,
    emits: 'order_id', label: 'Create order'
  }),
  'orders_v2.show': Object.freeze({
    method: 'GET', path: '/v2/checkout/orders/{id}', writes: false, reference: 'order_id',
    emits: null, label: 'Show order details'
  }),
  'orders_v2.capture': Object.freeze({
    method: 'POST', path: '/v2/checkout/orders/{id}/capture', writes: true, reference: 'order_id',
    emits: 'capture_id', label: 'Capture payment for order'
  }),
  'orders_v2.authorize': Object.freeze({
    method: 'POST', path: '/v2/checkout/orders/{id}/authorize', writes: true, reference: 'order_id',
    emits: 'authorization_id', label: 'Authorize payment for order'
  }),
  'payments_v2.capture_show': Object.freeze({
    method: 'GET', path: '/v2/payments/captures/{id}', writes: false, reference: 'capture_id',
    emits: null, label: 'Show captured payment details'
  }),
  'payments_v2.refund': Object.freeze({
    method: 'POST', path: '/v2/payments/captures/{id}/refund', writes: true, reference: 'capture_id',
    emits: 'refund_id', label: 'Refund captured payment'
  }),
  'payouts_v1.create': Object.freeze({
    method: 'POST', path: '/v1/payments/payouts', writes: true, reference: null,
    emits: 'payout_batch_id', label: 'Create batch payout'
  }),
  'payouts_v1.show': Object.freeze({
    method: 'GET', path: '/v1/payments/payouts/{id}', writes: false, reference: 'payout_batch_id',
    emits: null, label: 'Show payout batch details'
  })
});

/** Where each endpoint's emitted reference lives in PayPal's response body. */
export const REFERENCE_PATHS = Object.freeze({
  order_id: ['id'],
  capture_id: ['purchase_units', 0, 'payments', 'captures', 0, 'id'],
  authorization_id: ['purchase_units', 0, 'payments', 'authorizations', 0, 'id'],
  refund_id: ['id'],
  payout_batch_id: ['batch_header', 'payout_batch_id']
});

export function endpointFor(apiKey) {
  const endpoint = ENDPOINTS[apiKey];
  if (!endpoint) throw new Error(`unknown_api_key:${apiKey}`);
  return endpoint;
}

export function readPath(body, path) {
  let node = body;
  for (const step of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[step];
  }
  return typeof node === 'string' ? node : undefined;
}
