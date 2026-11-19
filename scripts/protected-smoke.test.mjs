import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { stringify } from 'yaml';

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
