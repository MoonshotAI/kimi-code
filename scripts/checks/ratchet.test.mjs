import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { compareCounts, countFindings, layeringFindings, ratchetBaseline, ratchetRules, reportChanges, ruleOf, runCountCheck, trackedFiles } from './ratchet.mjs';

await test('ruleOf turns an oxlint diagnostic code into the config rule name', () => {
  assert.equal(ruleOf('typescript(no-explicit-any)'), 'typescript/no-explicit-any');
  assert.equal(ruleOf('eslint(no-empty)'), 'eslint/no-empty');
  assert.equal(ruleOf('react-hooks(exhaustive-deps)'), 'react/exhaustive-deps');
  assert.equal(ruleOf(undefined), undefined);
  assert.equal(ruleOf(''), undefined);
});

await test('ratchetRules collects the rules that a config turns on at the root and in overrides', () => {
  const rules = ratchetRules({
    rules: { 'eslint/no-empty': 'error', 'eslint/no-console': 'off' },
    overrides: [
      { rules: { 'eslint/no-console': 'error', 'vitest/valid-title': 'allow' } },
      { rules: { 'typescript/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: false }] } },
    ],
  });
  assert.deepEqual(
    rules,
    new Set(['eslint/no-console', 'eslint/no-empty', 'typescript/switch-exhaustiveness-check']),
  );
});

const UNUSED = {
  message: 'Unused oxlint-disable directive (no problems were reported).',
  severity: 'error',
  filename: 'packages/core/src/a.ts',
};

await test('countFindings counts frozen warnings per file and keeps unused directives, unmatched warnings and enforced findings apart', () => {
  const NOT_FROZEN = { code: 'eslint(eqeqeq)', severity: 'warning', message: 'Expected ===.', filename: 'packages/core/src/a.ts' };
  const ENFORCED = { code: 'eslint(no-empty)', severity: 'error', message: 'Unexpected empty block.', filename: 'packages/core/src/d.ts' };
  const NO_CODE = { severity: 'error', message: 'Expected a semicolon.', filename: 'packages/core/src/c.ts' };
  const { counts, unused, unmatched, enforced } = countFindings(
    [
      { code: 'eslint(no-empty)', severity: 'warning', message: 'Unexpected empty block.', filename: 'packages/core/src/a.ts' },
      { code: 'eslint(no-empty)', severity: 'warning', message: 'Unexpected empty block.', filename: 'packages/core/src/a.ts' },
      { code: 'eslint(no-empty)', severity: 'warning', message: 'Unexpected empty block.', filename: 'packages/core/src/b.ts' },
      { code: 'react-hooks(exhaustive-deps)', severity: 'warning', message: 'Missing dependency.', filename: 'apps/vis/web/src/a.tsx' },
      NOT_FROZEN,
      ENFORCED,
      NO_CODE,
      UNUSED,
    ],
    new Set(['eslint/no-empty', 'react/exhaustive-deps']),
  );
  assert.deepEqual(counts, {
    'eslint/no-empty': { 'packages/core/src/a.ts': 2, 'packages/core/src/b.ts': 1 },
    'react/exhaustive-deps': { 'apps/vis/web/src/a.tsx': 1 },
  });
  assert.deepEqual(unused, [UNUSED]);
  assert.deepEqual(unmatched, [NOT_FROZEN]);
  assert.deepEqual(enforced, [ENFORCED, NO_CODE]);
});

const override = (files, rules, extra) => ({ files, env: null, globals: null, plugins: null, rules, ...extra });

const MAIN = {
  plugins: ['typescript', 'oxc'],
  jsPlugins: [],
  categories: {},
  settings: {},
  env: { builtin: true },
  globals: {},
  options: { typeAware: true },
  ignorePatterns: ['dist/', 'node_modules/'],
  rules: { eqeqeq: 'deny', 'typescript/no-floating-promises': 'deny' },
  overrides: [
    override(['apps/desktop/**/*'], { eqeqeq: 'allow' }),
    override(['**/*.test.ts'], { 'vitest/valid-title': 'deny' }, { plugins: ['vitest'] }),
  ],
};

function ratchetOver(main, { rules = {}, overrides = [], ...fields } = {}) {
  return {
    ...structuredClone(main),
    options: { ...main.options, reportUnusedDisableDirectives: 'deny' },
    rules: { ...main.rules, ...rules },
    overrides: [...structuredClone(main.overrides), ...overrides],
    ...fields,
  };
}

const findingsOf = (main, ratchet) => layeringFindings(main, ratchet).join('\n');

await test('layeringFindings accepts a ratchet config that only freezes rules on top of the main config', () => {
  const frozen = {
    rules: { 'no-empty': 'warn' },
    overrides: [
      override(['apps/desktop/**/*'], { eqeqeq: ['warn', { null: 'ignore' }] }),
      override(['**/*.test.ts'], { 'no-console': 'allow' }, { plugins: ['vitest'] }),
    ],
  };
  assert.deepEqual(layeringFindings(MAIN, ratchetOver(MAIN, frozen)), []);
  assert.deepEqual(layeringFindings(MAIN, ratchetOver(MAIN, { ...frozen, ignorePatterns: ['node_modules/', 'dist/'] })), []);
});

await test('layeringFindings refuses a ratchet setting that freezes or switches off a rule the main config enforces on those files', () => {
  assert.match(
    findingsOf(MAIN, ratchetOver(MAIN, { overrides: [override(['packages/core/**'], { eqeqeq: 'warn' })] })),
    /override for packages\/core\/\*\* sets eqeqeq to "warn", but \.oxlintrc\.json enforces eqeqeq on those files/,
  );
  assert.match(
    findingsOf(MAIN, ratchetOver(MAIN, { overrides: [override(['packages/core/**'], { 'typescript/no-floating-promises': 'allow' })] })),
    /sets typescript\/no-floating-promises to "off", but \.oxlintrc\.json enforces/,
  );
  const reenabled = { ...MAIN, overrides: [...MAIN.overrides, override(['apps/desktop/src/**'], { eqeqeq: 'deny' })] };
  assert.match(
    findingsOf(reenabled, ratchetOver(reenabled, { overrides: [override(['apps/desktop/**/*'], { eqeqeq: 'warn' })] })),
    /override for apps\/desktop\/\*\*\/\* sets eqeqeq to "warn", but \.oxlintrc\.json enforces eqeqeq/,
  );
  assert.match(findingsOf(MAIN, ratchetOver(MAIN, { rules: { eqeqeq: 'warn' } })), /eqeqeq at the root changes the setting \.oxlintrc\.json gives it/);
});

await test('layeringFindings refuses ratchet settings that enforce rules and a main config that uses warn', () => {
  assert.match(findingsOf(MAIN, ratchetOver(MAIN, { rules: { 'no-empty': 'deny' } })), /no-empty at the root is set to "error"\. Only "warn"/);
  assert.match(
    findingsOf(MAIN, ratchetOver(MAIN, { overrides: [override(['apps/desktop/**/*'], { eqeqeq: 'deny' })] })),
    /sets eqeqeq to "error"\. Only "warn" \(frozen\) and "off" belong/,
  );
  const warnedMain = { ...MAIN, rules: { ...MAIN.rules, 'no-var': 'warn' } };
  assert.match(findingsOf(warnedMain, ratchetOver(warnedMain)), /\.oxlintrc\.json sets no-var to "warn"/);
});

await test('layeringFindings refuses a ratchet config that changes what it shares with the main config', () => {
  assert.match(findingsOf(MAIN, ratchetOver(MAIN, { ignorePatterns: ['dist/'] })), /^ignorePatterns differ from \.oxlintrc\.json/m);
  assert.match(findingsOf(MAIN, ratchetOver(MAIN, { plugins: ['typescript'] })), /^plugins differ from \.oxlintrc\.json/m);
  assert.match(findingsOf(MAIN, ratchetOver(MAIN, { options: { typeAware: false } })), /^options\.typeAware differs from \.oxlintrc\.json/m);
  assert.match(
    findingsOf(MAIN, { ...ratchetOver(MAIN), overrides: [override(['apps/desktop/**/*'], { eqeqeq: 'warn' })] }),
    /the overrides of \.oxlintrc\.json are not applied first and unchanged/,
  );
  assert.match(
    findingsOf(MAIN, ratchetOver(MAIN, { overrides: [override(['apps/desktop/**/*'], { eqeqeq: 'warn' }, { plugins: ['react'] })] })),
    /sets plugins that no \.oxlintrc\.json override with the same files sets/,
  );
  assert.match(
    findingsOf(MAIN, ratchetOver(MAIN, { overrides: [override(['apps/desktop/**/*'], { eqeqeq: 'warn' }, { env: { browser: true } })] })),
    /sets env or globals/,
  );
});

const describeChange = (change) => `${change.kind} ${change.rule} ${change.file} ${change.from}→${change.to}`;

await test('compareCounts reports nothing when every file holds its count', () => {
  const counts = { 'eslint/no-empty': { 'a.ts': 2 } };
  assert.deepEqual(compareCounts(counts, structuredClone(counts)), []);
});

await test('compareCounts reports a file that gains findings, including a file the baseline does not list', () => {
  const changes = compareCounts(
    { 'eslint/no-empty': { 'a.ts': 2 } },
    { 'eslint/no-empty': { 'a.ts': 3, 'b.ts': 1 } },
  );
  assert.deepEqual(changes.map(describeChange), [
    'added eslint/no-empty a.ts 2→3',
    'added eslint/no-empty b.ts 0→1',
  ]);
});

await test('compareCounts reports fixed findings and rules that left the ratchet so the baseline shrinks', () => {
  const changes = compareCounts(
    { 'eslint/no-empty': { 'a.ts': 2 }, 'unicorn/no-array-sort': { 'c.ts': 1 } },
    { 'eslint/no-empty': { 'a.ts': 1 } },
  );
  assert.deepEqual(changes.map(describeChange), [
    'removed eslint/no-empty a.ts 2→1',
    'removed unicorn/no-array-sort c.ts 1→0',
  ]);
});

await test('compareCounts lists new findings before stale ones', () => {
  const changes = compareCounts(
    { 'eslint/no-empty': { 'b.ts': 1 } },
    { 'eslint/no-empty': { 'a.ts': 1 } },
  );
  assert.deepEqual(changes.map((change) => change.kind), ['added', 'removed']);
});

await test('ratchetBaseline only compares by default, refuses to raise the baseline on --update, and writes it sorted otherwise', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ratchet-baseline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'baselines', 'counts.json');
  const raised = { 'eslint/no-empty': { 'b.ts': 1, 'a.ts': 2 } };
  const added = [
    { kind: 'added', rule: 'eslint/no-empty', file: 'a.ts', from: 0, to: 2 },
    { kind: 'added', rule: 'eslint/no-empty', file: 'b.ts', from: 0, to: 1 },
  ];

  assert.deepEqual(ratchetBaseline(path, raised, []), { status: 'compared', changes: added });
  assert.deepEqual(ratchetBaseline(path, raised, ['--update']), { status: 'refused', changes: added });
  assert.equal(existsSync(path), false);

  assert.equal(ratchetBaseline(path, raised, ['--update', '--allow-increase']).status, 'written');
  assert.equal(readFileSync(path, 'utf8'), `${JSON.stringify({ 'eslint/no-empty': { 'a.ts': 2, 'b.ts': 1 } }, null, 2)}\n`);

  writeFileSync(path, JSON.stringify(raised));
  const lowered = ratchetBaseline(path, { 'eslint/no-empty': { 'b.ts': 1, 'a.ts': 1 } }, ['--update']);
  assert.deepEqual(lowered, { status: 'written', changes: [{ kind: 'removed', rule: 'eslint/no-empty', file: 'a.ts', from: 2, to: 1 }] });
  assert.equal(readFileSync(path, 'utf8'), `${JSON.stringify({ 'eslint/no-empty': { 'a.ts': 1, 'b.ts': 1 } }, null, 2)}\n`);
});

await test('runCountCheck rejects unknown arguments, fails on any change, and writes the baseline only on --update', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'count-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = [];
  t.mock.method(process.stdout, 'write', (text) => output.push(text));
  t.mock.method(process.stderr, 'write', (text) => output.push(text));
  const run = (args, counts) => runCountCheck({
    name: 'demo',
    root,
    checkFile: 'scripts/checks/demo.mjs',
    baselineFile: 'baselines/demo.json',
    args,
    measure: () => counts,
    formatReport: (changes) => changes.map((change) => `${change.file}: ${change.from} → ${change.to}`),
    summary: () => 'everything frozen',
  });
  const counts = { 'demo-rule': { 'a.ts': 1 } };

  assert.equal(run(['--bogus'], counts), 2);
  assert.equal(run(['--allow-increase'], counts), 2);
  assert.equal(run([], counts), 1);
  assert.equal(run(['--update'], counts), 1);
  assert.equal(existsSync(join(root, 'baselines/demo.json')), false);
  assert.equal(run(['--update', '--allow-increase'], counts), 0);
  assert.equal(run([], counts), 0);
  assert.equal(run([], {}), 1);
  assert.equal(run(['--update'], {}), 0);

  const text = output.join('');
  assert.match(text, /✗ demo: unsupported arguments --bogus/);
  assert.match(text, /a\.ts: 0 → 1/);
  assert.match(text, /✓ demo: wrote baselines\/demo\.json/);
  assert.match(text, /✓ demo: everything frozen/);
  assert.match(text, /a\.ts: 1 → 0/);
});

await test('trackedFiles lists tracked and untracked files, skips ignored ones, and narrows to the given paths', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tracked-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, 'kept'));
  writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
  writeFileSync(join(root, 'top.ts'), '');
  writeFileSync(join(root, 'ignored.ts'), '');
  writeFileSync(join(root, 'kept/inner.ts'), '');
  writeFileSync(join(root, 'kept/notes.md'), '');
  execFileSync('git', ['add', 'top.ts'], { cwd: root });

  const sources = (file) => file.endsWith('.ts');
  assert.deepEqual(trackedFiles(root, sources).toSorted(), ['kept/inner.ts', 'top.ts']);
  assert.deepEqual(trackedFiles(root, sources, ['kept/']), ['kept/inner.ts']);
});

await test('reportChanges describes new findings before fixed ones and stays silent when nothing changed', () => {
  const describe = {
    added: (added) => [`added ${added.map((change) => change.file).join(',')}`],
    removed: (removed) => [`removed ${removed.map((change) => change.file).join(',')}`],
  };
  const changes = [
    { kind: 'removed', rule: 'r', file: 'b.ts', from: 2, to: 1 },
    { kind: 'added', rule: 'r', file: 'a.ts', from: 0, to: 1 },
  ];
  assert.deepEqual(reportChanges(changes, describe), ['added a.ts', 'removed b.ts']);
  assert.deepEqual(reportChanges(changes.slice(0, 1), describe), ['removed b.ts']);
  assert.deepEqual(reportChanges([], describe), []);
});
