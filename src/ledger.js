// SPDX-FileCopyrightText: 2026 Francisco Angulo de Lafuente
// SPDX-License-Identifier: MIT
// Research-Project: PayPal Agentic Guardrail
// Research-Author: Francisco Angulo de Lafuente
// Research-ORCID: https://orcid.org/0009-0001-1634-7063
// Research-Date: 2026-11-07
/**
 * Append-only, hash-chained audit ledger.
 *
 * Every decision the broker makes is recorded here, including the ones that blocked a request.
 * The chain exists so that an operator reviewing what their agent did can tell whether the
 * record was edited after the fact: each entry carries the SHA-256 of the previous entry, so
 * removing or rewriting one breaks every link after it.
 *
 * The ledger is also the state the spending limits are evaluated against, which means a limit
 * can never be checked against a number that was not written down.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { addDecimal, compareDecimal, subtractDecimal } from './policy.js';

export const GENESIS = '0'.repeat(64);

/**
 * Outcomes that count as a security incident: something that actually happened. Zero tolerated.
 *
 * A blocked attempt is deliberately NOT one of these. An agent trying to set the payee and
 * being refused is the system working, and counting it as an incident would make every
 * successful defence look like a failure — and would let a two-arm comparison flatter whichever
 * arm has an interface to attack. Attempts are counted separately, below.
 */
export const INCIDENT_OUTCOMES = Object.freeze(new Set([
  'credential_exposed',
  'unbound_payee_paid',
  'amount_above_ceiling_paid',
  'destination_not_in_table',
  'charge_replayed',
  'policy_mutated'
]));

/**
 * Outcomes that record an agent reaching past its boundary and being stopped.
 *
 * There is deliberately no `policy_mutation_attempt`: the broker has no operation that edits the
 * policy, so an agent asking to widen a limit is simply naming an operation that does not exist
 * and is recorded as `refused: operation_not_allowed`. Listing an outcome nothing can produce
 * would imply a code path that is not there.
 */
export const BOUNDARY_ATTEMPT_OUTCOMES = Object.freeze(new Set(['bound_override_attempt']));

function hashEntry(entry, previous) {
  // The hash covers the canonical fields only, in a fixed order, so it does not depend on
  // JSON key ordering or on fields added by a later version.
  const canonical = [
    entry.seq, entry.at, entry.operation, entry.api, entry.outcome, entry.status ?? '',
    entry.amount ?? '', entry.currency ?? '', entry.reference ?? '', entry.reference_kind ?? '',
    entry.request_id ?? '', entry.detail ?? '', previous
  ].join('\u001f');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

const LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 120_000;

export class LedgerBusyError extends Error {
  constructor() {
    super('ledger_busy');
    this.code = 'ledger_busy';
  }
}

export class LedgerCorruptError extends Error {
  constructor(seq) {
    super(`ledger_corrupt:${seq}`);
    this.code = 'ledger_corrupt';
  }
}

export class Ledger {
  #path;
  #entries;
  #last;
  #now;
  #size = 0;

  constructor(path, now = () => Date.now()) {
    this.#now = now;
    this.#path = path;
    this.#entries = [];
    this.#last = GENESIS;
    if (path && existsSync(path)) this.#load();
    else if (path) mkdirSync(dirname(path), { recursive: true });
  }

  #load() {
    const text = readFileSync(this.#path, 'utf8');
    // Only whole lines: another process may be halfway through an append.
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    this.#entries = [];
    this.#last = GENESIS;
    for (const line of complete.split('\n')) {
      if (line.trim() === '') continue;
      const entry = JSON.parse(line);
      this.#entries.push(entry);
      this.#last = entry.hash;
    }
    this.#size = Buffer.byteLength(complete, 'utf8');
  }

  /** Pick up what other processes wrote. The console and the MCP server share this file. */
  refresh() {
    if (!this.#path || !existsSync(this.#path)) return;
    if (statSync(this.#path).size !== this.#size) this.#load();
  }

  /**
   * Run `work` holding the ledger across processes.
   *
   * A limit is only as good as the balance it reads. The console and the MCP server each hold a
   * Ledger on the same file, and an independent audit showed each spending a full daily cap
   * because neither saw the other's entries. The check and the write now happen under one lock,
   * on a fresh read. If the lock cannot be had, the call fails closed.
   */
  async exclusive(work) {
    if (!this.#path) return work();
    const lock = `${this.#path}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let age = 0;
        try {
          age = Date.now() - statSync(lock).mtimeMs;
        } catch {
          continue;
        }
        if (age > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > deadline) throw new LedgerBusyError();
        await new Promise(done => setTimeout(done, 20));
      }
    }
    try {
      // Re-read under the lock even when the byte count is unchanged: an edited amount can
      // have the same length as the original and must still invalidate the chain.
      if (!existsSync(this.#path)) {
        if (this.#size > 0) throw new LedgerCorruptError(this.#entries.length + 1);
      } else {
        const diskSize = statSync(this.#path).size;
        this.#load();
        // A partial final line means the record is incomplete, not a safe balance to spend.
        if (this.#size !== diskSize) throw new LedgerCorruptError(this.#entries.length + 1);
      }
      // Limits are read from this file. If it was edited, the balance cannot be trusted, so
      // nothing moves until a person has looked. This catches an edit, not a full rewrite of the
      // chain: the chain has no key.
      const check = this.verify();
      if (!check.ok) throw new LedgerCorruptError(check.brokenAt);
      return await work();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }

  get entries() {
    this.refresh();
    return this.#entries;
  }

  get head() {
    return this.#last;
  }

  /**
   * Record one decision. `outcome` is the broker's verdict, not PayPal's: a request blocked
   * before it left the process is recorded with no `status`.
   */
  append(record) {
    const entry = {
      seq: this.#entries.length + 1,
      // `now` lets the broker stamp entries with its injected clock, so a test that moves time
      // forward produces a ledger whose timestamps the limit checks actually agree with.
      at: record.at ?? new Date(this.#now()).toISOString(),
      operation: record.operation,
      api: record.api ?? '',
      outcome: record.outcome,
      status: record.status ?? null,
      amount: record.amount ?? null,
      currency: record.currency ?? null,
      reference: record.reference ?? null,
      reference_kind: record.reference_kind ?? null,
      request_id: record.request_id ?? null,
      detail: record.detail ?? null,
      prev: this.#last
    };
    entry.hash = hashEntry(entry, this.#last);
    this.#last = entry.hash;
    this.#entries.push(entry);
    if (this.#path) {
      appendFileSync(this.#path, `${JSON.stringify(entry)}\n`, 'utf8');
      this.#size = statSync(this.#path).size;
    }
    return entry;
  }

  /** Verify the chain. Returns `{ ok, brokenAt }`. */
  verify() {
    let previous = GENESIS;
    for (const entry of this.#entries) {
      if (entry.prev !== previous) return { ok: false, brokenAt: entry.seq, reason: 'prev_mismatch' };
      if (hashEntry(entry, previous) !== entry.hash) {
        return { ok: false, brokenAt: entry.seq, reason: 'hash_mismatch' };
      }
      previous = entry.hash;
    }
    return { ok: true, brokenAt: null };
  }

  get incidents() {
    return this.#entries.filter(entry => INCIDENT_OUTCOMES.has(entry.outcome));
  }

  /** Attempts that were stopped. Evidence the guardrail did something, not that it failed. */
  get blockedAttempts() {
    return this.#entries.filter(entry => BOUNDARY_ATTEMPT_OUTCOMES.has(entry.outcome));
  }

  /** Money actually moved by this operation since `since`, as a decimal string. */
  spentSince(operationName, since) {
    let total = '0.00';
    for (const entry of this.#entries) {
      if (entry.operation !== operationName || entry.outcome !== 'executed') continue;
      if (entry.amount === null) continue;
      if (Date.parse(entry.at) < since) continue;
      total = addDecimal(total, entry.amount);
    }
    return total;
  }

  callsSince(operationName, since) {
    return this.#entries.filter(entry =>
      entry.operation === operationName && entry.outcome === 'executed' &&
      Date.parse(entry.at) >= since).length;
  }

  /** Has this exact idempotency key already been executed? */
  hasRequestId(requestId) {
    return this.#entries.some(entry => entry.request_id === requestId && entry.outcome === 'executed');
  }

  /** The amount recorded when the broker issued this reference, or `null` if there is none. */
  amountOfReference(kind, value) {
    const entry = this.#entries.find(row =>
      row.outcome === 'executed' && row.reference === value && row.reference_kind === kind);
    return entry?.amount ?? null;
  }

  /**
   * What can still be refunded on a capture, as a decimal string, or `null` when the capture's
   * amount was never recorded. Counts every executed refund, so partial refunds add up.
   */
  refundableOnCapture(captureId) {
    const capture = this.#entries.find(entry =>
      entry.outcome === 'executed' && entry.reference === captureId &&
      entry.reference_kind === 'capture_id');
    const captured = /(?:^|\|)captured:(\d+\.\d{2})(?:\||$)/.exec(capture?.detail ?? '')?.[1];
    if (!captured) return null;
    let refunded = '0.00';
    for (const entry of this.#entries) {
      if (entry.outcome !== 'executed' || entry.amount === null) continue;
      if ((entry.detail ?? '').split('|').includes(`capture:${captureId}`)) {
        refunded = addDecimal(refunded, entry.amount);
      }
    }
    return subtractDecimal(captured, refunded);
  }

  /** References the broker itself issued, so the agent can only point at real prior results. */
  knownReference(kind, value) {
    return this.#entries.some(entry =>
      entry.outcome === 'executed' && entry.reference === value && entry.reference_kind === kind);
  }
}

/**
 * Evaluate the operator's spending limits against the ledger.
 * Returns `null` when the call is allowed, or a refusal code.
 */
export function checkLimits(operation, amount, ledger, now = Date.now()) {
  const { perCallMax, dailyTotalMax, maxCallsPerHour } = operation.limits;
  if (perCallMax !== null && amount !== null && compareDecimal(amount, perCallMax) > 0) {
    return { code: 'limit_per_call_exceeded', detail: `${amount} > ${perCallMax}` };
  }
  if (maxCallsPerHour !== null) {
    const calls = ledger.callsSince(operation.name, now - 3600_000);
    if (calls >= maxCallsPerHour) {
      return { code: 'limit_rate_exceeded', detail: `${calls} >= ${maxCallsPerHour}` };
    }
  }
  if (dailyTotalMax !== null && amount !== null) {
    const spent = ledger.spentSince(operation.name, now - 86_400_000);
    const projected = addDecimal(spent, amount);
    if (compareDecimal(projected, dailyTotalMax) > 0) {
      return { code: 'limit_daily_total_exceeded', detail: `${projected} > ${dailyTotalMax}` };
    }
  }
  return null;
}
