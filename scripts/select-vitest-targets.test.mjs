import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MAX_SHARDS, UNDECLARED_READS, dependentsOf, selectTargets, shardCount, workspacePatterns } from './select-vitest-targets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

const manifests = {
  'packages/engine': { name: '@x/engine' },
  'packages/server': { name: '@x/server', dependencies: { '@x/engine': 'workspace:^' } },
  'packages/kap-server': { name: '@x/kap-server' },
  'packages/agent-core-v2': { name: '@x/agent-core-v2' },
  'packages/app-core': { name: '@x/app-core' },
  'apps/cli': { name: 'cli', devDependencies: { '@x/server': 'workspace:^', react: '^19' } },
  'apps/desktop': { name: 'desktop', peerDependencies: { '@x/app-core': 'workspace:*' } },
  'tests/scenarios': { name: '@x/scenarios', devDependencies: { '@x/server': 'workspace:^' } },
  docs: { name: 'docs' },
};
const dependents = dependentsOf(manifests);
const select = changed => selectTargets({ changed, dependents });

await test('reads the package patterns of pnpm-workspace.yaml and stops at the next key', () => {
  const yaml = ['packages:', '  # comment', '  - packages/*', "  - 'apps/vis/server'", '  - "!packages/skip"', '', 'catalog:', '  - not-a-package'].join('\n');
  assert.deepEqual(workspacePatterns(yaml), ['packages/*', 'apps/vis/server', '!packages/skip']);
});

await test('reads every workspace pattern of this repository', () => {
  const patterns = workspacePatterns(readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8'));
  assert.ok(patterns.includes('packages/*'));
  assert.ok(patterns.includes('tests/scenarios'));
});

await test('runs a changed package and every package that depends on it, through all dependency fields', () => {
  assert.deepEqual(select(['packages/engine/src/a.ts']), {
    mode: 'some',
    targets: ['apps/cli/', 'packages/app-core/test/shortcutKeySources.test.ts', 'packages/engine/', 'packages/server/', 'tests/scenarios/'],
    reason: '1 changed file(s)',
  });
  assert.deepEqual(select(['packages/app-core/src/a.ts']).targets, ['apps/desktop/', 'packages/app-core/']);
});

await test('runs only the leaf package when nothing depends on it', () => {
  assert.deepEqual(select(['apps/cli/src/a.ts', 'apps/cli/test/a.test.ts']).targets, ['apps/cli/']);
});

await test('runs every test when a file shared by all tests changes', () => {
  for (const path of ['pnpm-lock.yaml', 'package.json', 'vitest.config.ts', 'tsconfig.base.json', 'build/raw-text-plugin.mjs', 'patches/x.patch', 'scripts/vitest-l0-gate.mjs', 'scripts/select-vitest-targets.mjs', '.github/workflows/ci.yml', '.nvmrc']) {
    const selection = select(['apps/cli/src/a.ts', path]);
    assert.equal(selection.mode, 'all', path);
    assert.match(selection.reason, new RegExp(path.replaceAll('.', '\\.')));
  }
});

await test('runs every test for a file outside the packages that is not known to be test-free', () => {
  assert.equal(select(['new-root-config.json']).mode, 'all');
  assert.equal(select(['tests/new-suite/a.test.ts']).mode, 'all');
});

await test('runs nothing for files that no vitest test reads', () => {
  const selection = select(['.changeset/a.md', '.github/workflows/e2e.yml', 'scripts/release.mjs', 'AGENTS.md', 'tests/protected.yaml', 'skills/use-kimi-code/SKILL.md', 'release-notes/2.0.0/en.md']);
  assert.deepEqual(selection, { mode: 'none', targets: [], reason: '7 changed file(s)' });
});

await test('runs nothing for a package without dependents and without tests', () => {
  assert.deepEqual(select(['docs/zh/index.md']).targets, ['docs/']);
});

await test('adds the tests that read files of another package without depending on it', () => {
  assert.deepEqual(select(['tests/scenarios/recordings/first-turn/trace.json']).targets, ['packages/app-core/test/replay/', 'tests/scenarios/']);
  assert.deepEqual(select(['tests/scenarios/capabilities/conversation.json']).targets, ['packages/acp-server/test/kap-parity.test.ts', 'tests/scenarios/']);
  assert.ok(select(['packages/agent-core-v2/docs/wire-manifest.d.ts']).targets.includes('apps/vis/web/test/renderers.test.ts'));
  assert.ok(select(['packages/kap-server/src/a.ts']).targets.includes('packages/agent-core-v2/test/environment/architectureBoundaries.test.ts'));
  assert.ok(select(['apps/desktop/src/renderer/a.vue']).targets.includes('packages/app-core/test/shortcutKeySources.test.ts'));
});

await test('drops a test file already covered by its selected package', () => {
  const targets = select(['packages/app-core/src/a.ts']).targets;
  assert.deepEqual(targets, ['apps/desktop/', 'packages/app-core/']);
});

await test('points every undeclared read at a test path that exists', () => {
  for (const read of UNDECLARED_READS) assert.ok(existsSync(new URL(read.tests, `file://${root}`)), read.tests);
});

await test('sizes the shard count by selected test files', () => {
  assert.equal(shardCount(0), 0);
  assert.equal(shardCount(1), 1);
  assert.equal(shardCount(320), 1);
  assert.equal(shardCount(321), 2);
  assert.equal(shardCount(100_000), MAX_SHARDS);
});
