import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { stringify } from 'yaml';

import DesktopSmokeReporter from '../apps/desktop/e2e/fixtures/smoke-reporter.ts';
import L0ResultsReporter, { L0_RESULTS_ENV } from './vitest-l0-gate.mjs';
import VitestSmokeReporter from './vitest-smoke-reporter.mjs';
import { checkProtectedExecutions, gateScope, protectedCases, readProtectedManifest } from './protected-smoke.ts';

const manifest = protectedCases();
const absolute = file => fileURLToPath(new URL('../' + file, import.meta.url));
const tagOf = { vitest: 'smoke', playwright: '@smoke' };
const executionOf = (entry, overrides = {}) => ({
  title: `[L0:${entry.id}] case`,
  file: absolute(entry.file),
  project: entry.project,
  status: 'passed',
  passed: true,
  tags: entry.kind === 'smoke' ? [tagOf[entry.runner]] : [],
  ...overrides,
});
const regression = {
  id: 'core.retry-after-overflow',
  kind: 'regression',
  runner: 'vitest',
  project: 'agent-core-v2',
  file: 'packages/agent-core-v2/test/agent/fullCompaction/fullCompaction.test.ts',
  behavior: 'compacts and retries after a context overflow that follows an earlier retry',
  source: 'core #4950',
  owner: '@RealKai42',
};

function withTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'l0-manifest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const runner of ['vitest', 'playwright']) {
  const selected = manifest.filter(entry => entry.runner === runner);
  const [first, ...others] = selected;
  const check = (...tests) => checkProtectedExecutions(runner, [...others.map(entry => executionOf(entry)), ...tests], { manifest });

  await test(`${runner} requires the specific L0 even if another smoke in its project passes`, () => {
    assert.deepEqual(check(executionOf(first)), []);
    const [message] = check(executionOf(first, { title: 'other passing smoke' }));
    assert.ok(message?.includes(`L0 ${first.id} (smoke)`));
    assert.match(message, /missing from runner results/);
  });

  await test(`${runner} rejects duplicate IDs, invalid locations, unsuccessful runs and a smoke without its tag`, () => {
    assert.match(check(executionOf(first), executionOf(first)).join('\n'), /duplicate ID/);
    assert.match(check(executionOf(first, { file: absolute(first.file) + '.other' })).join('\n'), /found at/);
    for (const status of ['skipped', 'failed', 'expected failure', 'passed (retry count=1)']) {
      assert.match(check(executionOf(first, { status, passed: false })).join('\n'), /did not pass on its first attempt/);
    }
    assert.match(check(executionOf(first, { tags: [] })).join('\n'), /registered as smoke but lacks the/);
  });
}

await test('regression and contract IDs are enforced on the full run from any project, without a smoke tag', () => {
  const contract = { ...regression, id: 'kap.schema', kind: 'contract', project: 'kap-server', file: 'packages/kap-server/test/apiSurface.test.ts' };
  const all = [...manifest, regression, contract];
  const smokeRuns = all.filter(entry => entry.runner === 'vitest' && entry.kind === 'smoke').map(entry => executionOf(entry));
  assert.deepEqual(checkProtectedExecutions('vitest', smokeRuns, { manifest: all, scope: 'smoke' }), []);
  const missing = checkProtectedExecutions('vitest', smokeRuns, { manifest: all, scope: 'all' }).join('\n');
  assert.match(missing, /L0 core\.retry-after-overflow \(regression\) .* missing from runner results/);
  assert.match(missing, /L0 kap\.schema \(contract\) .* missing from runner results/);
  const full = [...smokeRuns, executionOf(regression), executionOf(contract)];
  assert.deepEqual(checkProtectedExecutions('vitest', full, { manifest: all, scope: 'all' }), []);
  assert.deepEqual(checkProtectedExecutions('vitest', full, { manifest: all, scope: 'smoke' }), []);
  assert.match(
    checkProtectedExecutions('vitest', [...full, executionOf({ ...regression, id: 'core.unknown' })], { manifest: all, scope: 'all' }).join('\n'),
    /Unregistered L0 core\.unknown/,
  );
});

await test('a PR must still run a base ID when the head manifest drops or replaces it', t => {
  const dir = withTempDir(t);
  const base = join(dir, 'base.yaml');
  const head = join(dir, 'head.yaml');
  writeFileSync(base, readFileSync(new URL('../tests/protected.yaml', import.meta.url)));
  const { cases, requireSmoke } = readProtectedManifest(base);
  const [original, ...rest] = cases;
  writeFileSync(head, stringify({ require_smoke: requireSmoke, protected: rest.filter(entry => entry.project !== original.project) }));
  assert.throws(() => protectedCases(head, base), error => error.message.includes(original.id));
  const replacement = { ...original, id: original.id + '.replacement' };
  writeFileSync(head, stringify({ require_smoke: requireSmoke, protected: [replacement, ...rest, regression] }));
  const required = protectedCases(head, base);
  assert.ok(required.some(entry => entry.id === replacement.id));
  assert.ok(required.some(entry => entry.id === original.id));
  assert.ok(required.some(entry => entry.id === regression.id && entry.kind === 'regression'));
});

await test('a base manifest in the earlier smoke-only format is still enforced', t => {
  const dir = withTempDir(t);
  const legacy = join(dir, 'legacy.yaml');
  const legacyExtra = { ...manifest[0], id: 'core.legacy-extra' };
  const legacyEntries = [...manifest, legacyExtra].map(({ kind: _kind, runner: _runner, ...entry }) => entry);
  writeFileSync(legacy, stringify({ smoke: legacyEntries }));
  const read = readProtectedManifest(legacy);
  assert.deepEqual(read.requireSmoke, ['agent-core-v2', 'scenarios', 'cli', 'smoke']);
  assert.deepEqual(read.cases.map(entry => [entry.id, entry.kind, entry.runner]), [...manifest, legacyExtra].map(entry => [entry.id, 'smoke', entry.runner]));
  const head = join(dir, 'head.yaml');
  writeFileSync(head, stringify({ require_smoke: [], protected: manifest }));
  assert.deepEqual(protectedCases(head, legacy).map(entry => entry.id).toSorted(), [...manifest.map(entry => entry.id), legacyExtra.id].toSorted());
});

await test('the manifest declares which projects need a smoke and rejects unknown kinds or runners', t => {
  const dir = withTempDir(t);
  const head = join(dir, 'head.yaml');
  writeFileSync(head, stringify({ require_smoke: ['agent-core-v2', 'vscode'], protected: manifest }));
  assert.throws(() => protectedCases(head, ''), /No L0 smoke registered for vscode/);
  for (const broken of [{ ...regression, kind: 'nice-to-have' }, { ...regression, runner: 'jest' }, { ...regression, file: '../outside.ts' }]) {
    writeFileSync(head, stringify({ require_smoke: [], protected: [broken] }));
    assert.throws(() => readProtectedManifest(head), /Invalid L0 entry/);
  }
});

await test('both runner adapters reject a protected test which passed only on retry, and the Vitest gate fails closed', async t => {
  const messages = [];
  t.mock.method(process.stderr, 'write', message => { messages.push(String(message)); return true; });
  const savedExit = process.exitCode;
  const savedMode = process.env.KIMI_E2E_PROTECTED;
  try {
    process.env.KIMI_E2E_PROTECTED = '1';
    const desktop = new DesktopSmokeReporter();
    for (const entry of manifest.filter(e => e.runner === 'playwright')) {
      const task = { title: `[L0:${entry.id}] case`, location: { file: absolute(entry.file) },
        parent: { project: () => ({ name: entry.project }) }, expectedStatus: 'passed', tags: ['@smoke'] };
      desktop.onTestEnd(task, { status: 'failed', retry: 0 });
      desktop.onTestEnd(task, { status: 'passed', retry: 1 });
    }
    assert.deepEqual(await desktop.onEnd(), { status: 'failed' });
    const assertRetryReported = entry => assert.ok(messages.some(message =>
      message.includes(`L0 ${entry.id} (smoke) [${entry.project}]`) && message.includes('retry count=1')));
    manifest.filter(entry => entry.runner === 'playwright').forEach(assertRetryReported);
    new VitestSmokeReporter().onTestRunEnd(manifest.filter(e => e.runner === 'vitest').map(entry => ({
      project: { name: entry.project }, moduleId: absolute(entry.file),
      children: { allTests: () => [{ name: `[L0:${entry.id}] case`, tags: ['smoke'], options: {},
        result: () => ({ state: 'passed' }), diagnostic: () => ({ retryCount: 1 }) }] },
    })));
    assert.equal(process.exitCode, 1);
    manifest.filter(entry => entry.runner === 'vitest').forEach(assertRetryReported);
    process.exitCode = undefined;
    new VitestSmokeReporter().onTestRunEnd([]);
    assert.equal(process.exitCode, 1);
    assert.ok(messages.some(message => message.includes('No Vitest results reached the L0 gate')));
  } finally {
    process.exitCode = savedExit;
    if (savedMode === undefined) delete process.env.KIMI_E2E_PROTECTED;
    else process.env.KIMI_E2E_PROTECTED = savedMode;
  }
});

await test('Playwright L0 entries must be smoke, and a PR cannot drop a project the base requires', t => {
  const dir = withTempDir(t);
  const head = join(dir, 'head.yaml');
  const desktop = manifest.find(entry => entry.runner === 'playwright');
  writeFileSync(head, stringify({ require_smoke: [], protected: [{ ...desktop, kind: 'regression' }] }));
  assert.throws(() => readProtectedManifest(head), /Playwright entries must be smoke/);
  const base = join(dir, 'base.yaml');
  writeFileSync(base, readFileSync(new URL('../tests/protected.yaml', import.meta.url)));
  writeFileSync(head, stringify({ require_smoke: ['agent-core-v2'], protected: manifest.filter(entry => entry.project !== 'cli') }));
  assert.throws(() => protectedCases(head, base), /No L0 smoke registered for cli/);
});

await test('each shard records its results, and the gate decides from L0 results only', t => {
  const dir = withTempDir(t);
  const results = join(dir, 'results');
  const moduleOf = (entry, state = 'passed') => ({
    project: { name: entry.project }, moduleId: absolute(entry.file),
    children: { allTests: () => [{ name: `[L0:${entry.id}] case`, tags: ['smoke'], options: {}, result: () => ({ state }), diagnostic: () => ({ retryCount: 0 }) }] },
  });
  const unrelatedFailure = {
    project: { name: 'scenarios' }, moduleId: absolute('tests/scenarios/other.test.ts'),
    children: { allTests: () => [{ name: 'an unrelated failure', tags: [], options: {}, result: () => ({ state: 'failed' }), diagnostic: () => ({ retryCount: 0 }) }] },
  };
  const savedResults = process.env[L0_RESULTS_ENV];
  const record = (name, modules) => {
    if (name === undefined) delete process.env[L0_RESULTS_ENV];
    else process.env[L0_RESULTS_ENV] = join(results, name);
    new L0ResultsReporter().onTestRunEnd(modules);
  };
  const gate = directory => spawnSync(process.execPath, [fileURLToPath(new URL('./vitest-l0-gate.mjs', import.meta.url)), directory], { cwd: dir, encoding: 'utf8' });
  const vitestEntries = manifest.filter(entry => entry.runner === 'vitest');
  try {
    record('l0-1.json', [moduleOf(vitestEntries[0]), unrelatedFailure]);
    record('l0-2.json', vitestEntries.slice(1).map(entry => moduleOf(entry)));
    assert.throws(() => record(undefined, []), /Set KIMI_L0_RESULTS/);
  } finally {
    if (savedResults === undefined) delete process.env[L0_RESULTS_ENV];
    else process.env[L0_RESULTS_ENV] = savedResults;
  }
  assert.equal(JSON.parse(readFileSync(join(results, 'l0-1.json'), 'utf8'))[0].file, vitestEntries[0].file);

  const passed = gate(results);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /✓ L0 gate: .* from 2 shard files/);

  rmSync(join(results, 'l0-2.json'));
  const missing = gate(results);
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes(`L0 ${vitestEntries[1].id} (${vitestEntries[1].kind})`) && missing.stderr.includes('missing from runner results'), missing.stderr);

  const none = gate(join(dir, 'absent'));
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No Vitest results reached the L0 gate/);
});

await test('the desktop reporter rejects a misspelled gate scope instead of narrowing it', async () => {
  const savedMode = process.env.KIMI_E2E_PROTECTED;
  const savedScope = process.env.KIMI_L0_SCOPE;
  try {
    process.env.KIMI_E2E_PROTECTED = '1';
    process.env.KIMI_L0_SCOPE = 'ALL';
    await assert.rejects(new DesktopSmokeReporter().onEnd(), /KIMI_L0_SCOPE must be "smoke" or "all"/);
  } finally {
    if (savedMode === undefined) delete process.env.KIMI_E2E_PROTECTED;
    else process.env.KIMI_E2E_PROTECTED = savedMode;
    if (savedScope === undefined) delete process.env.KIMI_L0_SCOPE;
    else process.env.KIMI_L0_SCOPE = savedScope;
  }
});

await test('the gate scope must be spelled exactly', () => {
  assert.equal(gateScope(undefined), 'smoke');
  assert.equal(gateScope('all'), 'all');
  assert.throws(() => gateScope('ALL'), /KIMI_L0_SCOPE must be "smoke" or "all"/);
});
