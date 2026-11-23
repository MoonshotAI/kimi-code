import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LABEL, selectJourneys } from './select-e2e-specs.mjs';

const exists = path => !path.includes('deleted');
const script = fileURLToPath(new URL('./select-e2e-specs.mjs', import.meta.url));

await test('runs every journey outside pull requests', () => {
  assert.deepEqual(selectJourneys({ pullRequest: false, labelled: false, changed: [] }), { mode: 'full', specs: [], reason: 'not a pull request' });
});

await test('runs every journey when the pull request has the label, whatever it changes', () => {
  assert.deepEqual(selectJourneys({ pullRequest: true, labelled: true, changed: ['README.md'], exists }), {
    mode: 'full',
    specs: [],
    reason: `the pull request has the ${LABEL} label`,
  });
});

await test('skips the journeys for a pull request that does not change them, and says how to ask for them', () => {
  const selection = selectJourneys({
    pullRequest: true,
    labelled: false,
    exists,
    changed: ['packages/agent-core-v2/src/loop.ts', 'apps/desktop/src/renderer/App.vue', 'packages/app-client/src/a.ts', 'pnpm-lock.yaml'],
  });
  assert.equal(selection.mode, 'none');
  assert.deepEqual(selection.specs, []);
  assert.match(selection.reason, new RegExp(`add the ${LABEL} label to run them`));
});

await test('runs only the changed specs when nothing else in the journeys changed', () => {
  assert.deepEqual(selectJourneys({
    pullRequest: true,
    labelled: false,
    exists,
    changed: [
      'apps/desktop/e2e/turn-steer.spec.ts',
      'apps/desktop/test/e2e/environment/home-isolation.spec.ts',
      'apps/desktop/e2e/turn-steer.spec.ts',
      'packages/core/src/a.ts',
    ],
  }), { mode: 'specs', specs: ['e2e/turn-steer.spec.ts', 'test/e2e/environment/home-isolation.spec.ts'], reason: '2 changed spec(s)' });
});

await test('runs every journey when a shared journey file changes', () => {
  for (const path of [
    'apps/desktop/e2e/fixtures/app.ts',
    'apps/desktop/e2e/playwright.config.ts',
    'packages/testkit/src/model/fake-model.ts',
    '.github/workflows/desktop-e2e.yml',
    'apps/desktop/scripts/ci/select-e2e-specs.mjs',
  ]) {
    const selection = selectJourneys({ pullRequest: true, labelled: false, exists, changed: [path, 'apps/desktop/e2e/turn-steer.spec.ts'] });
    assert.equal(selection.mode, 'full', path);
    assert.deepEqual(selection.shared, [path]);
  }
});

await test('runs nothing when the only changed specs were deleted', () => {
  assert.deepEqual(selectJourneys({ pullRequest: true, labelled: false, exists, changed: ['apps/desktop/e2e/deleted.spec.ts'] }), {
    mode: 'none',
    specs: [],
    reason: 'only deleted specs changed',
  });
});

await test('writes the mode and the specs to the workflow output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'select-e2e-specs-'));
  try {
    const run = (args, input) => {
      const output = join(dir, `output-${args.length}`);
      const result = spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } });
      assert.equal(result.status, 0, result.stderr);
      return { stdout: result.stdout, output: readFileSync(output, 'utf8') };
    };
    const unrelated = run(['--pull-request'], 'packages/core/src/a.ts\n');
    assert.equal(unrelated.output, 'mode=none\nspecs=\n');
    assert.match(unrelated.stdout, /Desktop e2e mode: none/);
    assert.equal(run(['--pull-request', '--labelled'], 'packages/core/src/a.ts\n').output, 'mode=full\nspecs=\n');
    assert.equal(run([], '').output, 'mode=full\nspecs=\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
