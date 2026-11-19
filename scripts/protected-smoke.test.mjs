import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { stringify } from 'yaml';

import DesktopSmokeReporter from '../apps/desktop/e2e/fixtures/smoke-reporter.ts';
import VitestSmokeReporter from './vitest-smoke-reporter.mjs';
import { checkSmokeExecutions, protectedSmokeCases } from './protected-smoke.ts';

const manifest = protectedSmokeCases();
const executions = manifest.map(entry => ({
  title: `[L0:${entry.id}] first turn`,
  file: fileURLToPath(new URL('../' + entry.file, import.meta.url)),
  project: entry.project,
  status: 'passed',
  passed: true,
}));

for (const runner of ['vitest', 'playwright']) {
  const selected = executions.filter(test => (test.project === 'smoke') === (runner === 'playwright'));
  const first = selected[0];
  const others = selected.slice(1);
  const check = (...tests) => checkSmokeExecutions(runner, [...others, ...tests], manifest);
  await test(`${runner} requires the specific L0 even if another smoke in its project passes`, () => {
    assert.deepEqual(check(first), []);
    const [message] = check({ ...first, title: 'other passing smoke' });
    assert.ok(message?.includes(first.title.split(']')[0].slice(4)));
    assert.match(message, /missing from runner results/);
  });
  await test(`${runner} rejects duplicate IDs, invalid locations and unsuccessful executions`, () => {
    assert.match(check(first, first).join('\n'), /duplicate ID/);
    assert.match(check({ ...first, file: first.file + '.other' }).join('\n'), /found at/);
    for (const status of ['skipped', 'failed', 'expected failure']) {
      assert.match(check({ ...first, status, passed: false }).join('\n'), /did not pass as a normal smoke/);
    }
  });
}

await test('a PR must still run a base ID when the head manifest drops or replaces it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'l0-manifest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = join(dir, 'base.yaml');
  const head = join(dir, 'head.yaml');
  writeFileSync(base, readFileSync(new URL('../tests/protected.yaml', import.meta.url)));
  const [original, ...rest] = protectedSmokeCases(base, '');
  writeFileSync(head, stringify({ smoke: rest.filter(entry => entry.project !== original.project) }));
  assert.throws(() => protectedSmokeCases(head, base), error => error.message.includes(original.id));
  const replacement = { ...original, id: original.id + '.replacement' };
  writeFileSync(head, stringify({ smoke: [replacement, ...rest] }));
  const required = protectedSmokeCases(head, base);
  assert.ok(required.some(entry => entry.id === replacement.id));
  assert.ok(required.some(entry => entry.id === original.id));
});

await test('both runner adapters reject a protected test which passed only on retry', async t => {
  const messages = [];
  t.mock.method(process.stderr, 'write', message => { messages.push(String(message)); return true; });
  const savedExit = process.exitCode;
  const savedMode = process.env.KIMI_E2E_PROTECTED;
  try {
    process.env.KIMI_E2E_PROTECTED = '1';
    const desktop = new DesktopSmokeReporter();
    for (const entry of manifest.filter(e => e.project === 'smoke')) {
      const task = { title: `[L0:${entry.id}] case`, location: { file: fileURLToPath(new URL('../' + entry.file, import.meta.url)) },
        parent: { project: () => ({ name: 'smoke' }) }, expectedStatus: 'passed', tags: ['@smoke'] };
      desktop.onTestEnd(task, { status: 'failed', retry: 0 });
      desktop.onTestEnd(task, { status: 'passed', retry: 1 });
    }
    assert.deepEqual(await desktop.onEnd(), { status: 'failed' });
    const assertRetryReported = entry => assert.ok(messages.some(message =>
      message.includes(`L0 ${entry.id} [${entry.project}]`) && message.includes('retry count=1')));
    manifest.filter(entry => entry.project === 'smoke').forEach(assertRetryReported);
    new VitestSmokeReporter().onTestRunEnd(manifest.filter(e => e.project !== 'smoke').map(entry => ({
      project: { name: entry.project }, moduleId: fileURLToPath(new URL('../' + entry.file, import.meta.url)),
      children: { allTests: () => [{ name: `[L0:${entry.id}] case`, tags: ['smoke'], options: {},
        result: () => ({ state: 'passed' }), diagnostic: () => ({ retryCount: 1 }) }] },
    })));
    assert.equal(process.exitCode, 1);
    manifest.filter(entry => entry.project !== 'smoke').forEach(assertRetryReported);
  } finally {
    process.exitCode = savedExit;
    if (savedMode === undefined) delete process.env.KIMI_E2E_PROTECTED;
    else process.env.KIMI_E2E_PROTECTED = savedMode;
  }
});
