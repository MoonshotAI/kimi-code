import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const REPEATS = 5;
export const MOST = 3;
export const BUDGET = 10 * 60 * 1000;

const GRACE = 60 * 1000;
const E2E_DIR = resolve(import.meta.dirname, '../tests/e2e');
const REPRODUCED = new Set(['failed', 'timedOut']);

function escaped(text) {
  return text.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);
}

function pathPattern(path, separator) {
  return path.split('/').map(escaped).join(separator);
}

export function titleGrep({ projectName, file, title }) {
  return `/^${escaped(projectName)} ${pathPattern(file, String.raw`[\\/]`)} ${escaped(title)}$/`;
}

export function playwrightArgs({ failure, repeats, timeout, output }) {
  return [
    'test',
    `${pathPattern(failure.file, String.raw`[\\/]`)}$`,
    `--project=${failure.projectName}`,
    `--grep=${titleGrep(failure)}`,
    `--repeat-each=${repeats}`,
    `--global-timeout=${timeout}`,
    '--reporter=list,json',
    `--output=${output}`,
  ];
}

export function repeatsIn(report, failure, repeats) {
  const tests = (report.suites ?? [])
    .filter(suite => suite.file === failure.file)
    .flatMap(suite => suite.specs ?? [])
    .filter(spec => spec.title === failure.title)
    .flatMap(spec => spec.tests)
    .filter(test => test.projectName === failure.projectName);
  if (tests.length === 0) {
    const reason = report.errors?.[0]?.message?.split('\n')[0];
    throw new Error(`Playwright did not select the case${reason === undefined ? '' : `: ${reason}`}`);
  }
  const statuses = tests.flatMap(test => test.results.map(result => result.status));
  const failed = statuses.filter(status => REPRODUCED.has(status)).length;
  const passed = statuses.filter(status => status === 'passed').length;
  return { failed, passed, unfinished: Math.max(0, repeats - failed - passed) };
}

function rerunCase(failure, { repeats, timeout, runCase }) {
  try {
    if (typeof failure.projectName !== 'string') throw new Error('the results file does not name the Playwright project of this case');
    return repeatsIn(runCase({ failure, repeats, timeout }), failure, repeats);
  } catch (error) {
    return { failed: 0, passed: 0, unfinished: repeats, error: error.message };
  }
}

export function rerunFailures({ results, runCase, save, now = Date.now, repeats = REPEATS, most = MOST, budget = BUDGET }) {
  const chosen = Math.min(most, results.failures.length);
  const deadline = now() + budget;
  const failures = results.failures.map((failure, index) => (index < chosen ? { ...failure, rerun: { failed: 0, passed: 0, unfinished: repeats } } : failure));
  const current = { ...results, rerun: { repeats, most }, failures };
  save(current);
  for (let index = 0; index < chosen; index += 1) {
    const timeout = Math.floor((deadline - now()) / (chosen - index));
    if (timeout <= 0) break;
    failures[index].rerun = rerunCase(failures[index], { repeats, timeout, runCase });
    save(current);
  }
  return current;
}

function playwrightRun({ failure, repeats, timeout }) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-rerun-'));
  const report = join(dir, 'report.json');
  const cli = createRequire(join(E2E_DIR, 'package.json')).resolve('@playwright/test/cli');
  const child = spawnSync(process.execPath, [cli, ...playwrightArgs({ failure, repeats, timeout, output: join(dir, 'test-results') })], {
    cwd: E2E_DIR,
    stdio: 'inherit',
    timeout: timeout + GRACE,
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: report },
  });
  if (child.error !== undefined) throw child.error;
  if (!existsSync(report)) throw new Error(`Playwright ended with ${child.status ?? child.signal} without writing its JSON report`);
  return JSON.parse(readFileSync(report, 'utf8'));
}

function outcomeLine(failure) {
  const place = `${failure.projectName ?? failure.project} › ${failure.file} › ${failure.title}`;
  const { rerun } = failure;
  if (rerun === undefined) return `not rerun: ${place}`;
  const counts = `${rerun.failed} failed, ${rerun.passed} passed, ${rerun.unfinished} unfinished`;
  return `${rerun.error === undefined ? counts : `${counts} (${rerun.error})`}: ${place}`;
}

function main() {
  const { values } = parseArgs({ options: { results: { type: 'string' } } });
  const path = values.results;
  if (path === undefined || path === '') throw new Error('Pass --results with the E2E_RESULTS_FILE the suite wrote');
  if (!existsSync(path)) {
    console.log(`${path} does not exist, so the suite wrote no failed cases to rerun.`);
    return;
  }
  const results = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(results.failures)) throw new Error(`${path} has no failures list; it was not written by run-summary`);
  if (results.failures.length === 0) {
    console.log('No failed case to rerun.');
    return;
  }
  const save = current => writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
  const rerun = rerunFailures({ results, runCase: playwrightRun, save });
  console.log(`Reran the first ${Math.min(MOST, results.failures.length)} failed cases up to ${REPEATS} times each on this commit:`);
  for (const failure of rerun.failures) console.log(`- ${outcomeLine(failure)}`);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
