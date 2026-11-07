#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Francisco Angulo de Lafuente
# SPDX-License-Identifier: MIT
# Research-Project: PayPal Agentic Guardrail
# Research-Author: Francisco Angulo de Lafuente
# Research-ORCID: https://orcid.org/0009-0001-1634-7063
# Research-Date: 2026-11-07
"""Experiment E2: are the broker's requests valid under PayPal's published OpenAPI documents?

    git clone https://github.com/paypal/paypal-rest-api-specifications /tmp/spec
    git -C /tmp/spec checkout 90e8041ffe02d80c452d2b476bedd59a8d219bdc
    pip install jsonschema referencing
    python bench/conformance.py --spec /tmp/spec

This shows schema conformance. It does not show that PayPal accepts a request at run time: only
the sandbox can show that. Negative controls run too, because a check that nothing can fail
proves nothing.
"""

import argparse
import copy
import json
import re
import subprocess
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

PINNED_COMMIT = "90e8041ffe02d80c452d2b476bedd59a8d219bdc"
ROOT = Path(__file__).resolve().parent.parent
DOCUMENTS = {
    "orders_v2": "checkout_orders_v2.json",
    "payments_v2": "payments_payment_v2.json",
    "payouts_v1": "payments_payouts_batch_v1.json",
}

COMPOSE = r"""
import { composeBody, loadPolicyFile } from './src/policy.js';
import { ENDPOINTS } from './src/paypal-api.js';
const env = { OPERATOR_MERCHANT_ID: 'ABCDEFGHJKLMN', OPERATOR_SUPPLIER_EMAIL: 'supplier@operator.example' };
const policy = loadPolicyFile('policy/operations.json', env);
const samples = { amount: '49.00', sku: 'SKU-PRO', note: 'Refund as agreed' };
const out = {};
for (const [name, operation] of policy.operations) {
  const values = Object.fromEntries(operation.agent.map(field => [field.name, samples[field.name]]));
  out[name] = {
    api: operation.api,
    method: operation.endpoint.method,
    path: operation.endpoint.path,
    body: operation.endpoint.method === 'GET' ? null
      : composeBody(operation, values, { request_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f901234' })
  };
}
const table = Object.entries(ENDPOINTS).map(([api, e]) => ({ api, method: e.method, path: e.path }));
console.log(JSON.stringify({ operations: out, table }));
"""


def normalise(path):
    return re.sub(r"\{[^}]*\}", "{}", path)


def load_specs(spec_dir):
    specs = {}
    for key, name in DOCUMENTS.items():
        specs[key] = json.loads((spec_dir / "openapi" / name).read_text(encoding="utf8"))
    return specs


def find_operation(specs, api, method, path):
    document = specs[api.split(".")[0]]
    for raw_path, item in document["paths"].items():
        if normalise(raw_path) == normalise(path) and method.lower() in item:
            return document, item[method.lower()]
    return None, None


def request_schema(document, operation):
    body = operation.get("requestBody")
    if body is None:
        return None
    if "$ref" in body:
        body = document["components"]["requestBodies"][body["$ref"].rsplit("/", 1)[-1]]
    return body["content"]["application/json"]["schema"]


def validator_for(document, schema):
    resource = Resource(contents=document, specification=DRAFT202012)
    registry = Registry().with_resource("urn:paypal", resource)
    wrapped = json.loads(json.dumps(schema).replace('"#/', '"urn:paypal#/'))
    return Draft202012Validator(wrapped, registry=registry)


def errors(document, schema, body):
    return [
        f"{'/'.join(map(str, error.absolute_path))}: {error.message[:140]}"
        for error in validator_for(document, schema).iter_errors(body)
    ]


def drop(body, *steps):
    mutated = copy.deepcopy(body)
    target = mutated
    for step in steps[:-1]:
        target = target[step]
    del target[steps[-1]]
    return mutated


def change(body, value, *steps):
    mutated = copy.deepcopy(body)
    target = mutated
    for step in steps[:-1]:
        target = target[step]
    target[steps[-1]] = value
    return mutated


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--out", default=ROOT / "bench/results/conformance.json", type=Path)
    args = parser.parse_args()

    composed = json.loads(subprocess.run(
        ["node", "--input-type=module", "-e", COMPOSE],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout)
    specs = load_specs(args.spec)

    routes = []
    for entry in composed["table"]:
        document, operation = find_operation(specs, entry["api"], entry["method"], entry["path"])
        routes.append({**entry, "in_specification": operation is not None})

    results = []
    for name, entry in composed["operations"].items():
        document, operation = find_operation(specs, entry["api"], entry["method"], entry["path"])
        row = {"operation": name, "api": entry["api"], "route_found": operation is not None}
        if operation is not None and entry["body"] is not None:
            schema = request_schema(document, operation)
            if schema is None:
                row["schema"] = "none declared"
                row["errors"] = []
            else:
                row["schema"] = "checked"
                row["errors"] = errors(document, schema, entry["body"])
        else:
            row["schema"] = "no body"
            row["errors"] = []
        row["valid"] = row["route_found"] and not row["errors"]
        results.append(row)

    order = composed["operations"]["charge_customer_eur"]
    payout = composed["operations"]["pay_supplier_eur"]
    refund = composed["operations"]["refund_capture_eur"]
    unit = ("purchase_units", 0)
    controls = [
        ("order without intent", order, drop(order["body"], "intent")),
        ("order without purchase_units", order, drop(order["body"], "purchase_units")),
        ("item without name (the body before the fix)", order, drop(order["body"], *unit, "items", 0, "name")),
        ("item without quantity (the body before the fix)", order, drop(order["body"], *unit, "items", 0, "quantity")),
        ("item without unit_amount (the body before the fix)", order, drop(order["body"], *unit, "items", 0, "unit_amount")),
        ("amount as a number", order, change(order["body"], 49, *unit, "amount", "value")),
        ("currency code of the wrong length", order, change(order["body"], "EURO", *unit, "amount", "currency_code")),
        ("merchant id of the wrong shape", order, change(order["body"], "attacker", *unit, "payee", "merchant_id")),
        ("refund amount as a number", refund, change(refund["body"], 10, "amount", "value")),
        ("payout without items", payout, drop(payout["body"], "items")),
        ("payout without sender_batch_header", payout, drop(payout["body"], "sender_batch_header")),
    ]
    negative = []
    for label, entry, body in controls:
        document, operation = find_operation(specs, entry["api"], entry["method"], entry["path"])
        found = errors(document, request_schema(document, operation), body)
        negative.append({"control": label, "rejected": bool(found), "first_error": found[0] if found else None})

    report = {
        "specification": "https://github.com/paypal/paypal-rest-api-specifications",
        "commit": PINNED_COMMIT,
        "routes_in_specification": sum(row["in_specification"] for row in routes),
        "routes_total": len(routes),
        "operations_valid": sum(row["valid"] for row in results),
        "operations_total": len(results),
        "negative_controls_rejected": sum(row["rejected"] for row in negative),
        "negative_controls_total": len(negative),
        "routes": routes,
        "operations": results,
        "negative_controls": negative,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf8")
    print(json.dumps({key: value for key, value in report.items() if not isinstance(value, list)}, indent=2))
    for row in results:
        if row["errors"]:
            print(row["operation"], row["errors"])
    for row in negative:
        if not row["rejected"]:
            print("NOT REJECTED:", row["control"])
    for row in routes:
        if not row["in_specification"]:
            print("ROUTE MISSING:", row)


if __name__ == "__main__":
    main()
