import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { protectedCases } from './protected-smoke.ts';
import { executionsOf, gateErrors } from './vitest-smoke-reporter.mjs';

export const L0_RESULTS_ENV = 'KIMI_L0_RESULTS';

const root = fileURLToPath(new URL('../', import.meta.url));

export default class L0ResultsReporter {
  onTestRunEnd(modules) {
    const path = process.env[L0_RESULTS_ENV];
    if (!path) throw new Error(`Set ${L0_RESULTS_ENV} to the file that keeps this run's results for the L0 gate`);
    const executions = executionsOf(modules).map(execution => ({ ...execution, file: relative(root, execution.file).split(sep).join('/') }));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(executions));
  }
}

export function checkL0Results(directory) {
  const files = existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.json')).toSorted() : [];
  const executions = files.flatMap(name => JSON.parse(readFileSync(join(directory, name), 'utf8')));
  return { files, executions, errors: gateErrors(executions, 'all') };
}

if (import.meta.main) {
  const [directory, ...rest] = process.argv.slice(2);
  if (!directory || rest.length) throw new Error('Usage: node scripts/vitest-l0-gate.mjs <directory of shard results>');
  const { files, executions, errors } = checkL0Results(directory);
  if (errors.length) {
    process.stderr.write(['✗ L0 gate: protected tests are missing or did not pass on their first attempt', ...errors].join('\n') + '\n');
    process.exitCode = 1;
  } else {
    const count = protectedCases().filter(entry => entry.runner === 'vitest').length;
    process.stdout.write(`✓ L0 gate: all ${count} protected Vitest tests passed on their first attempt among ${executions.length} results from ${files.length} shard files. Other failures are reported by the test jobs.\n`);
  }
}
