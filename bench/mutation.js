#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Francisco Angulo de Lafuente
// SPDX-License-Identifier: MIT
// Research-Project: PayPal Agentic Guardrail
// Research-Author: Francisco Angulo de Lafuente
// Research-ORCID: https://orcid.org/0009-0001-1634-7063
// Research-Date: 2026-11-07
/**
 * Experiment E3: if a safeguard is removed, does the evidence notice?
 *
 * Each mutant removes one safeguard from a temporary copy of the repository. It is killed when a
 * test fails or when the guardrail arm of the bench reports an incident. A mutant that survives
 * is a gap in the evidence, which is exactly what this is here to find.
 *
 *   node bench/mutation.js [--work <dir>]
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MUTANTS = [
  {
    id: 'M01', safeguard: 'bound fields are applied last', file: 'src/policy.js',
    from: '    setPath(body, entry.path, entry.value);\n', to: '    if (entry.path.join(\'.\').includes(\'currency\')) setPath(body, entry.path, entry.value);\n'
  },
  {
    id: 'M02', safeguard: 'limits are checked before a call', file: 'src/broker.js',
    from: 'const limitRefusal = checkLimits(operation, amount, this.#ledger, this.#clock()) ??\n      this.#refundRefusal(operation, reference, amount);',
    to: 'const limitRefusal = null;'
  },
  {
    id: 'M03', safeguard: 'limits are checked again on approval', file: 'src/broker.js',
    from: 'const limitRefusal = checkLimits(operation, ticket.amount, this.#ledger, this.#clock()) ??\n        this.#refundRefusal(operation, ticket.reference, ticket.amount);',
    to: 'const limitRefusal = null;'
  },
  {
    id: 'M04', safeguard: 'references must be ones the broker issued', file: 'src/broker.js',
    from: 'if (!this.#ledger.knownReference(operation.endpoint.reference, reference)) {',
    to: 'if (false) {'
  },
  {
    id: 'M05', safeguard: 'repeated requests are suppressed', file: 'src/broker.js',
    from: 'if (requestId && this.#ledger.hasRequestId(requestId)) {', to: 'if (false) {'
  },
  {
    id: 'M06', safeguard: 'amounts over the threshold wait for approval', file: 'src/broker.js',
    from: 'if (this.#requiresApproval(operation, amount)) {', to: 'if (false) {'
  },
  {
    id: 'M07', safeguard: 'unknown request fields are refused', file: 'src/broker.js',
    from: 'if (unknownFields.length > 0) {', to: 'if (false) {'
  },
  {
    id: 'M08', safeguard: 'undeclared parameters are refused', file: 'src/policy.js',
    from: "if (!operation.agentNames.has(key)) throw new PolicyError('parameter_not_allowed', key);",
    to: 'if (!operation.agentNames.has(key)) continue;'
  },
  {
    id: 'M09', safeguard: 'a decimal cannot exceed its declared maximum', file: 'src/policy.js',
    from: "if (compareDecimal(given, field.max) > 0) throw new PolicyError('parameter_above_max', field.name);",
    to: ''
  },
  {
    id: 'M10', safeguard: 'a refund cannot exceed its capture', file: 'src/broker.js',
    from: "if (operation.api !== 'payments_v2.refund' || amount === null) return null;", to: 'return null;'
  },
  {
    id: 'M11', safeguard: 'the approval link must be on a PayPal host', file: 'src/broker.js',
    from: "return url.protocol === 'https:' && onPayPal ? url.href : null;", to: 'return url.href;'
  },
  {
    id: 'M12', safeguard: 'requests run one at a time', file: 'src/broker.js',
    from: '      await previous;\n      return await this.#executeSerial(request);',
    to: '      return await this.#executeSerial(request);'
  },
  {
    id: 'M13', safeguard: 'the response is reduced to listed fields', file: 'src/broker.js',
    from: "    const fields = { ok: true, status: 'executed' };\n",
    to: "    const fields = { ok: true, status: 'executed', upstream: response.json };\n"
  },
  {
    id: 'M14', safeguard: 'free text cannot carry URLs or addresses', file: 'src/policy.js',
    from: "throw new PolicyError('parameter_text_forbidden_content', field.name);", to: ';'
  },
  {
    id: 'M15', safeguard: 'the ledger chain detects an edited entry', file: 'src/ledger.js',
    from: "if (hashEntry(entry, previous) !== entry.hash) {", to: 'if (false) {'
  }
];

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 });
}

function evaluate(dir) {
  const tests = run(process.execPath, ['--test', 'tests/*.test.js'], dir);
  const failed = /^# fail (\d+)/m.exec(tests.stdout ?? '');
  const testFailures = failed ? Number(failed[1]) : -1;
  const bench = run(process.execPath, ['bench/run.js', '--variants', '1', '--out', 'bench/mutant-results'], dir);
  const latest = join(dir, 'bench/mutant-results/latest-mock.json');
  let guardrail = null;
  if (existsSync(latest)) guardrail = JSON.parse(readFileSync(latest, 'utf8')).summary.arms.guardrail;
  return {
    test_failures: testFailures,
    bench_incidents: guardrail?.incidents ?? null,
    bench_attacks_blocked: guardrail ? `${guardrail.attacks_blocked}/${guardrail.adversarial_runs}` : null
  };
}

function main() {
  const workFlag = process.argv.indexOf('--work');
  const base = workFlag >= 0 ? process.argv[workFlag + 1] : tmpdir();
  const results = [];
  const baselineDir = mkdtempSync(join(base, 'guardrail-mutant-'));
  const copy = target => {
    for (const name of ['src', 'tests', 'bench', 'policy', 'package.json']) {
      cpSync(join(repoRoot, name), join(target, name), {
        recursive: true, filter: source => !source.includes('results')
      });
    }
    symlinkSync(join(repoRoot, 'node_modules'), join(target, 'node_modules'), 'junction');
  };
  copy(baselineDir);
  const baseline = evaluate(baselineDir);
  rmSync(join(baselineDir, 'node_modules'), { recursive: false, force: true });
  rmSync(baselineDir, { recursive: true, force: true });
  process.stdout.write(`baseline ${JSON.stringify(baseline)}\n`);
  // A baseline that already fails would mark every mutant as killed. The first version of this
  // script did exactly that: a bad test path gave 15/15 and proved nothing.
  if (baseline.test_failures !== 0 || baseline.bench_incidents !== 0) {
    throw new Error('the unmutated repository must pass before mutants mean anything');
  }

  for (const mutant of MUTANTS) {
    const dir = mkdtempSync(join(base, 'guardrail-mutant-'));
    copy(dir);
    const path = join(dir, mutant.file);
    const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    if (!source.includes(mutant.from)) {
      results.push({ id: mutant.id, safeguard: mutant.safeguard, applied: false });
      process.stdout.write(`${mutant.id} NOT APPLIED\n`);
    } else {
      writeFileSync(path, source.replace(mutant.from, mutant.to), 'utf8');
      const outcome = evaluate(dir);
      const killed = outcome.test_failures !== 0 || (outcome.bench_incidents ?? 0) > 0;
      results.push({ id: mutant.id, safeguard: mutant.safeguard, applied: true, killed, ...outcome });
      process.stdout.write(`${mutant.id} ${killed ? 'killed  ' : 'SURVIVED'} ${mutant.safeguard} ${JSON.stringify(outcome)}\n`);
    }
    rmSync(join(dir, 'node_modules'), { recursive: false, force: true });
    rmSync(dir, { recursive: true, force: true });
  }

  const applied = results.filter(row => row.applied);
  const report = {
    baseline,
    mutants_applied: applied.length,
    mutants_killed: applied.filter(row => row.killed).length,
    mutants: results
  };
  writeFileSync(resolve(repoRoot, 'bench/results/mutation.json'), JSON.stringify(report, null, 2), 'utf8');
  process.stdout.write(`killed ${report.mutants_killed}/${report.mutants_applied}\n`);
}

main();
