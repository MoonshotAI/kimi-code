import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareCounts } from './ratchet.mjs';
import { caseNames, countCases, countLegacyCases, formatReport, isLegacyE2eFile } from './legacy-e2e.mjs';

await test('isLegacyE2eFile looks only at sources under the paused E2E directories', () => {
  assert.equal(isLegacyE2eFile('apps/desktop/e2e/core-turn.spec.ts'), true);
  assert.equal(isLegacyE2eFile('apps/desktop/e2e/fixtures/app.ts'), true);
  assert.equal(isLegacyE2eFile('apps/desktop/test/e2e/environment/home-isolation.spec.ts'), true);
  assert.equal(isLegacyE2eFile('apps/kimi-code/test/e2e/tui/conversation/first-turn.test.ts'), true);
  assert.equal(isLegacyE2eFile('apps/kimi-code/test/e2e/real-llm-smoke.e2e.test.ts'), false);
  assert.equal(isLegacyE2eFile('apps/kimi-code/test/tui/controller.test.ts'), false);
  assert.equal(isLegacyE2eFile('apps/desktop/tests/renderer/layout.test.ts'), false);
  assert.equal(isLegacyE2eFile('tests/e2e/scenarios/files/read-and-edit.spec.ts'), false);
  assert.equal(isLegacyE2eFile('apps/desktop/e2e/README.md'), false);
});

await test('caseNames follows imports and extend aliases of a test function', () => {
  const text = [
    "import { expect, testWithProvider as journey } from '../../e2e/fixtures/app';",
    'const withSecrets = journey.extend({});',
    'const small = test.extend({});',
    'const unrelated = other.extend({});',
  ].join('\n');
  assert.deepEqual(caseNames(text).toSorted(), ['it', 'journey', 'small', 'test', 'testWithProvider', 'withSecrets']);
});

await test('countCases counts each declared case, including modifiers, conditions and aliases, but not steps, groups or regex tests', () => {
  const text = [
    "import { test as base } from './fixtures/app';",
    'const small = base.extend({});',
    "test('plain', async () => {});",
    "test.skip('skipped', async () => {});",
    "test.runIf(process.platform !== 'win32')('conditional', async () => {});",
    "it.skipIf(isWindows())('vitest style', () => {});",
    "testWithProvider('with provider', async () => {});",
    "small(`template title`, async () => {});",
    "base('aliased base', async () => {});",
    "test.describe('group', () => {});",
    "await test.step('step', async () => {});",
    "if (/^x/.test('x')) {}",
  ].join('\n');
  assert.equal(countCases(text), 7);
});

await test('countLegacyCases keeps per-file counts for the paused directories only', () => {
  const counts = countLegacyCases([
    { file: 'apps/desktop/e2e/core-turn.spec.ts', text: "test('a', async () => {});\ntest('b', async () => {});" },
    { file: 'apps/desktop/e2e/fixtures/app.ts', text: 'export const test = base.extend({});' },
    { file: 'tests/e2e/scenarios/turn/stop.spec.ts', text: "scenario('x', {}, async () => {});\ntest('y', () => {});" },
  ]);
  assert.deepEqual(counts, { 'legacy-e2e-case': { 'apps/desktop/e2e/core-turn.spec.ts': 2 } });
  assert.deepEqual(countLegacyCases([]), {});
});

await test('a new case points to tests/e2e, a removed one asks to lower the baseline', () => {
  const baseline = { 'legacy-e2e-case': { 'apps/desktop/e2e/a.spec.ts': 2 } };
  const added = formatReport(compareCounts(baseline, {
    'legacy-e2e-case': { 'apps/desktop/e2e/a.spec.ts': 3, 'apps/kimi-code/test/e2e/tui/trust/new.test.ts': 4 },
  })).join('\n');
  assert.match(added, /new test cases in an E2E directory that no longer runs automatically/);
  assert.match(added, /apps\/desktop\/e2e\/a\.spec\.ts: 2 → 3/);
  assert.match(added, /apps\/kimi-code\/test\/e2e\/tui\/trust\/new\.test\.ts: 0 → 4/);
  assert.match(added, /instead: write the case in tests\/e2e/);
  const removed = formatReport(compareCounts(baseline, {})).join('\n');
  assert.match(removed, /allows more cases than these directories have/);
  assert.match(removed, /apps\/desktop\/e2e\/a\.spec\.ts: 2 → 0/);
  assert.deepEqual(formatReport(compareCounts(baseline, baseline)), []);
});
