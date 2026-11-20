import assert from 'node:assert/strict';
import { test } from 'node:test';

import { baselineFailures, changedLines, leakedProcesses, mutationTargets, parseProcessTable, runResult, strykerConfig, summarize } from './mutation-diff.mjs';

const diff = [
  'diff --git a/packages/kit/src/a.ts b/packages/kit/src/a.ts',
  '--- a/packages/kit/src/a.ts',
  '+++ b/packages/kit/src/a.ts',
  '@@ -3 +3 @@ export const a = 1;',
  '-old',
  '+new',
  '@@ -10,0 +11,2 @@',
  '+one',
  '+two',
  '@@ -20,2 +22,0 @@',
  '-gone',
  '-gone',
  '@@ -30 +31,3 @@',
  '+x',
  'diff --git a/packages/kit/src/removed.ts b/packages/kit/src/removed.ts',
  '--- a/packages/kit/src/removed.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-gone',
  'diff --git a/packages/kit/src/b.ts b/packages/kit/src/b.ts',
  '--- /dev/null',
  '+++ b/packages/kit/src/b.ts',
  '@@ -0,0 +1,4 @@',
  '+export const b = 2;',
  '@@ -0,0 +5 @@',
  '+export const c = 3;',
].join('\n');

await test('reads the added lines of each file from a zero-context diff', () => {
  assert.deepEqual([...changedLines(diff)], [
    ['packages/kit/src/a.ts', [[3, 3], [11, 12], [31, 33]]],
    ['packages/kit/src/b.ts', [[1, 5]]],
  ]);
});

await test('keeps file names with spaces, quotes and non-ASCII letters', () => {
  const unusual = [
    '+++ b/packages/kit/src/my file.ts\t',
    '@@ -1 +1 @@',
    '+++ "b/packages/kit/src/naïve \\"quoted\\".ts"\t',
    '@@ -2 +2,2 @@',
    '+++ "b/packages/kit/src/caf\\303\\251 \\"x\\".ts"\t',
    '@@ -3 +3 @@',
    '+++ b/packages/kit/src/naïve.ts',
    '@@ -4 +4 @@',
  ].join('\n');
  assert.deepEqual([...changedLines(unusual)], [
    ['packages/kit/src/my file.ts', [[1, 1]]],
    ['packages/kit/src/naïve "quoted".ts', [[2, 3]]],
    ['packages/kit/src/café "x".ts', [[3, 3]]],
    ['packages/kit/src/naïve.ts', [[4, 4]]],
  ]);
});

await test('mutates source files of packages with a Vitest config and reports the rest', () => {
  const files = new Set([
    'packages/kit/package.json', 'packages/kit/vitest.config.ts',
    'packages/bare/package.json',
    'apps/vis/server/package.json', 'apps/vis/server/vitest.config.mts',
  ]);
  const changes = new Map([
    ['packages/kit/src/a.ts', [[3, 3], [11, 12]]],
    ['packages/kit/src/a.test.ts', [[1, 2]]],
    ['packages/kit/src/b.spec.mts', [[1, 2]]],
    ['packages/kit/src/__tests__/c.ts', [[1, 2]]],
    ['packages/kit/src/types.d.ts', [[1, 2]]],
    ['packages/kit/test/a.test.ts', [[1, 9]]],
    ['packages/kit/README.md', [[1, 1]]],
    ['packages/kit/vitest.config.ts', [[1, 1]]],
    ['packages/bare/src/index.ts', [[4, 4]]],
    ['apps/vis/server/src/nested/b.mts', [[7, 8]]],
    ['scripts/tool.mjs', [[1, 1]]],
  ]);
  const { packages, skipped } = mutationTargets(changes, path => files.has(path), () => 'export const value = 1;\n');
  assert.deepEqual([...packages], [
    ['packages/kit', { config: 'vitest.config.ts', mutate: ['src/a.ts:3-3', 'src/a.ts:11-12'] }],
    ['apps/vis/server', { config: 'vitest.config.mts', mutate: ['src/nested/b.mts:7-8'] }],
  ]);
  assert.deepEqual(skipped.map(entry => entry.subject), ['packages/bare/src/index.ts']);
  assert.match(skipped[0].reason, /packages\/bare has no Vitest config/);
});

await test('does not mutate code that starts or stops processes, because a mutant there can kill the runner', () => {
  const files = new Set(['packages/kit/package.json', 'packages/kit/vitest.config.ts']);
  const sources = new Map([
    ['packages/kit/src/spawns.ts', "import { spawn } from 'node:child_process';\nexport const start = () => spawn('node');\n"],
    ['packages/kit/src/requires.cjs', "const { execFile } = require('child_process');\n"],
    ['packages/kit/src/kills.ts', 'export function stop(pid: number) { process.kill(-pid, "SIGKILL"); }\n'],
    ['packages/kit/src/fixture.ts', "import { TestProcess } from '#/fixtures/process';\nconst child = TestProcess.start(options);\n"],
    ['packages/kit/src/reaper.ts', 'killProcessTree(child.pid);\n'],
    ['packages/kit/src/plain.ts', 'export const pattern = /x/;\npattern.exec(text);\nagent.spawn(task);\nsession.fork();\n'],
    ['packages/kit/src/index.ts', "export { killProcessTree, TestProcess } from './process';\n"],
  ]);
  const changes = new Map([...sources.keys()].map(path => [path, [[1, 2]]]));
  const { packages, skipped } = mutationTargets(changes, path => files.has(path), path => sources.get(path));
  assert.deepEqual([...packages], [['packages/kit', { config: 'vitest.config.ts', mutate: ['src/plain.ts:1-2', 'src/index.ts:1-2'] }]]);
  assert.deepEqual(skipped.map(entry => entry.subject), [
    'packages/kit/src/spawns.ts',
    'packages/kit/src/requires.cjs',
    'packages/kit/src/kills.ts',
    'packages/kit/src/fixture.ts',
    'packages/kit/src/reaper.ts',
  ]);
  for (const entry of skipped) assert.match(entry.reason, /starts or stops operating-system processes/);
});

await test('finds the processes a mutation run leaked: marked with its checkout, but no longer under a marked parent', () => {
  const table = parseProcessTable([
    '  101     1 node /tmp/kimi-mutation-AbC123/checkout/node_modules/@stryker-mutator/core/bin/stryker.js run',
    '  102   101 node /tmp/kimi-mutation-AbC123/checkout/node_modules/@stryker-mutator/core/dist/src/child-proxy/child-process-proxy-worker.js',
    '  103   102 node --import file:///private/tmp/kimi-mutation-AbC123/checkout/packages/kit/src/preload.ts stub-server.mjs',
    '  104     1 node --import file:///private/tmp/kimi-mutation-AbC123/checkout/packages/kit/src/preload.ts orphan.mjs',
    '  105  4242 node --import file:///private/tmp/kimi-mutation-AbC123/checkout/packages/kit/src/preload.ts adopted-by-a-subreaper.mjs',
    '  106     1 node /tmp/kimi-mutation-Other9/checkout/stub.mjs',
    '  107     1 node unrelated.js',
    'not a process line',
  ].join('\n'));
  assert.equal(table.length, 7);
  assert.deepEqual(table[2], { pid: 103, ppid: 102, command: 'node --import file:///private/tmp/kimi-mutation-AbC123/checkout/packages/kit/src/preload.ts stub-server.mjs' });
  assert.deepEqual(leakedProcesses(table, 'kimi-mutation-AbC123', 101), [104, 105]);
});

await test('runs each package in place with its own config and only the related tests', () => {
  const config = strykerConfig({ config: 'vitest.config.ts', mutate: ['src/a.ts:1-2'] }, '/reports/packages-kit', { vitestRunner: '/runner.js' });
  assert.equal(config.inPlace, true);
  assert.equal(config.ignoreStatic, true);
  assert.deepEqual(config.vitest, { configFile: 'vitest.config.ts', related: true });
  assert.deepEqual(config.plugins, ['/runner.js']);
  assert.equal(config.thresholds.break, null);
  assert.equal(config.jsonReporter.fileName, '/reports/packages-kit.json');
  assert.equal(strykerConfig({ config: 'vitest.config.ts', mutate: [] }, '/r', { vitestRunner: '/runner.js', includeStatic: true }).ignoreStatic, false);
});

await test('tells a package without related tests apart from a Stryker error', () => {
  const report = { files: {} };
  assert.deepEqual(runResult('packages/kit', { code: 0, report, log: '', logPath: 'kit.log' }), { packageDir: 'packages/kit', report });
  const untested = 'INFO DryRunExecutor No tests were found\nERROR Stryker No tests were executed. Stryker will exit prematurely.';
  assert.deepEqual(runResult('packages/pi-tui', { code: 1, report: undefined, log: untested, logPath: 'pi-tui.log' }), { packageDir: 'packages/pi-tui', untested: true });
  const baseline = 'One or more tests failed in the initial test run:\n\tsome test\nThere were failed tests in the initial test run.';
  assert.deepEqual(runResult('packages/server', { code: 1, report: undefined, log: baseline, logPath: 'server.log' }).baseline, [{ test: 'some test', details: [] }]);
  assert.deepEqual(runResult('packages/broken', { code: 1, report: undefined, log: 'TypeError: boom', logPath: '.tmp/mutation/packages-broken.log' }), {
    packageDir: 'packages/broken',
    error: 'Stryker exited with code 1 before writing a report; see .tmp/mutation/packages-broken.log',
  });
});

await test('reports a package stopped by the time budget, unless Stryker still wrote its report', () => {
  assert.deepEqual(runResult('packages/slow', { code: null, outOfTime: true, budgetMinutes: 35, report: undefined, log: '', logPath: 'slow.log' }), {
    packageDir: 'packages/slow',
    stopped: 'stopped when the 35-minute budget ran out, before Stryker wrote a report',
  });
  const report = { files: {} };
  assert.deepEqual(runResult('packages/slow', { code: 0, outOfTime: true, budgetMinutes: 35, report, log: '', logPath: 'slow.log' }), { packageDir: 'packages/slow', report });
});

await test('reads the tests that failed before any mutation from the Stryker log', () => {
  const log = [
    '\u001b[31m10:48:54 (78665) ERROR DryRunExecutor\u001b[39m One or more tests failed in the initial test run:',
    '\tplugins expands tilde paths',
    '\t\texpected 50001 to be +0 // Object.is equality',
    '\tsessions archives a session',
    '10:48:54 (78665) ERROR Stryker There were failed tests in the initial test run.',
    '\tnot a failure',
  ].join('\n');
  assert.deepEqual(baselineFailures(log), [
    { test: 'plugins expands tilde paths', details: ['expected 50001 to be +0 // Object.is equality'] },
    { test: 'sessions archives a session', details: [] },
  ]);
  assert.deepEqual(baselineFailures('INFO Done'), []);
});

await test('lists surviving and uncovered mutants with their code, and every package it could not mutate', () => {
  const location = (line, startColumn, endColumn) => ({ start: { line, column: startColumn }, end: { line, column: endColumn } });
  const report = {
    files: {
      'src/a.ts': {
        source: 'const keys = [\'a\', \'b\'];\nif (count > limit) stop();\n',
        mutants: [
          { mutatorName: 'ConditionalExpression', replacement: 'false', status: 'Killed', location: location(2, 5, 18) },
          { mutatorName: 'EqualityOperator', replacement: 'count >= limit', status: 'Survived', location: location(2, 5, 18) },
          { mutatorName: 'ArrayDeclaration', replacement: '[]', status: 'Ignored', location: location(1, 14, 24) },
          { mutatorName: 'BlockStatement', replacement: '{}', status: 'NoCoverage', location: location(2, 20, 26) },
        ],
      },
    },
  };
  const summary = summarize({
    base: 'abc123',
    results: [
      { packageDir: 'packages/kit', report },
      { packageDir: 'packages/server', baseline: [{ test: 'expands tilde paths', details: ['expected 50001 to be +0'] }] },
      { packageDir: 'packages/broken', error: 'Stryker exited with code 1 before writing a report; see .tmp/mutation/packages-broken.log' },
      { packageDir: 'packages/pi-tui', untested: true },
      { packageDir: 'packages/slow', stopped: 'stopped when the 35-minute budget ran out, before Stryker wrote a report' },
    ],
    skipped: [{ subject: 'packages/bare/src/index.ts', reason: 'packages/bare has no Vitest config, so nothing runs its tests under Stryker' }],
  });
  assert.match(summary, /Compared with `abc123`/);
  assert.match(summary, /\| packages\/kit \| 1 \| 1 \| 1 \| 0 \| 0 \| 0 \| 1 \|/);
  assert.match(summary, /- `packages\/kit\/src\/a.ts:2` EqualityOperator, survived: `count > limit` → `count >= limit`/);
  assert.match(summary, /- `packages\/kit\/src\/a.ts:2` BlockStatement, no related test runs this line: `stop\(\)` → `\{\}`/);
  assert.doesNotMatch(summary, /ConditionalExpression|ArrayDeclaration/);
  assert.match(summary, /- packages\/server: these related tests fail under Stryker before any mutation[^\n]*\n {2}- expands tilde paths \(expected 50001 to be \+0\)/);
  assert.match(summary, /- packages\/broken: Stryker exited with code 1/);
  assert.match(summary, /- packages\/pi-tui: no Vitest test of this package imports the changed files/);
  assert.match(summary, /- packages\/slow: stopped when the 35-minute budget ran out/);
  assert.match(summary, /- packages\/bare\/src\/index.ts: packages\/bare has no Vitest config/);
  assert.match(summarize({ base: 'abc', results: [], skipped: [] }), /No changed lines under a package `src` directory/);
});
