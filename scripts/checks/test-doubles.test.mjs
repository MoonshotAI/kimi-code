import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareCounts } from './ratchet.mjs';
import { countLegacyDoubles, ENGINE_HARNESS_IMPORTERS, formatReport, isCheckedFile, stubTestNames } from './test-doubles.mjs';

await test('isCheckedFile looks at test sources only and skips the shared kit and the legacy doubles themselves', () => {
  assert.equal(isCheckedFile('packages/kap-server/test/sessions.test.ts'), true);
  assert.equal(isCheckedFile('apps/desktop/e2e/core-turn.spec.ts'), true);
  assert.equal(isCheckedFile('tests/scenarios/support/scenario.ts'), true);
  assert.equal(isCheckedFile('packages/kap-server/src/server.ts'), false);
  assert.equal(isCheckedFile('packages/testkit/test/model.test.ts'), false);
  assert.equal(isCheckedFile('apps/desktop/e2e/fixtures/model.ts'), false);
  assert.equal(isCheckedFile('packages/agent-core-v2/test/harness/agent.ts'), false);
  assert.equal(isCheckedFile('apps/desktop/e2e/README.md'), false);
  assert.equal(isCheckedFile('scripts/checks/test-doubles.test.mjs'), false);
});

await test('stubTestNames finds the stub test export, following aliases, and ignores the testkit export', () => {
  assert.deepEqual(stubTestNames("import { expect, test, testWithProvider } from './fixtures/app';"), ['test']);
  assert.deepEqual(stubTestNames("import { test as base } from '../../e2e/fixtures/app';"), ['base']);
  assert.deepEqual(stubTestNames("import { expect, testWithProvider as test } from './fixtures/app';"), []);
});

await test('countLegacyDoubles counts each legacy double per file', () => {
  const counts = countLegacyDoubles([
    {
      file: 'packages/agent-core-v2/test/tool/tool.test.ts',
      text: "ctx.mockNextResponse({ type: 'text' });\nctx.mockNextProviderResponse({ parts: [] });",
    },
    {
      file: 'apps/desktop/e2e/core-turn.spec.ts',
      text: [
        "import { expect, test, testWithProvider } from './fixtures/app';",
        "import { say } from './fixtures/model';",
        "test('old journey', async () => {});",
        "test.skip('skipped old journey', async () => {});",
        "testWithProvider('new journey', async () => {});",
      ].join('\n'),
    },
    { file: 'apps/desktop/test/e2e/new.spec.ts', text: "import { expect, testWithProvider as test } from '../../e2e/fixtures/app';\ntest('x', async () => {});" },
    { file: 'packages/klient/test/e2e/matrix.test.ts', text: "object: 'chat.completion.chunk'" },
    { file: 'packages/core/test/llm/openai.test.ts', text: "object: 'chat.completion.chunk'" },
    { file: 'packages/acp-server/test/helper.ts', text: "import { x } from '../../agent-core-v2/test/harness/scripted-generate';" },
    { file: 'packages/agent-core-v2/test/other.test.ts', text: "import { x } from '../harness/agent-core-v2/test/harness';" },
  ]);
  assert.deepEqual(counts, {
    'engine-mock-response': { 'packages/agent-core-v2/test/tool/tool.test.ts': 2 },
    'desktop-stub-model': { 'apps/desktop/e2e/core-turn.spec.ts': 3 },
    'inline-openai-stream': { 'packages/klient/test/e2e/matrix.test.ts': 1 },
    'engine-harness-import': { 'packages/acp-server/test/helper.ts': 1 },
  });
});

await test('countLegacyDoubles counts direct calls to the engine harness provider helpers but not their imports or types', () => {
  const counts = countLegacyDoubles([
    {
      file: 'packages/agent-core-v2/test/agent/fullCompaction/fullCompaction.test.ts',
      text: [
        "import { createMockProvider, withMockProvider } from '../../harness/scripted-generate';",
        'type Scripted = ReturnType<typeof createScriptedGenerate>;',
        'const generate = createMockProvider(async () => ({ parts: [] }));',
        'const wrapped = withMockProvider(initial, generate);',
        'const backed = fetchBackedProvider(model.fetch);',
        'const other = harness.createMockProvider(handler);',
      ].join('\n'),
    },
  ]);
  assert.deepEqual(counts, { 'engine-mock-provider': { 'packages/agent-core-v2/test/agent/fullCompaction/fullCompaction.test.ts': 3 } });
});

await test('a loop-core unit test may keep the requester-level helper', () => {
  const counts = countLegacyDoubles([
    {
      file: 'packages/agent-core-v2/test/agent/loop/toolAdapter.test.ts',
      text: "const requester = createMockProviderRequester((_request, signal) => ({ parts: [] }));\nconst listed = createMockProviderRequester([{ parts: [] }]);",
    },
  ]);
  assert.deepEqual(counts, {});
});

await test('a listed engine harness importer is exempt and names its reason', () => {
  const file = 'packages/product/test/survey-turns.test.ts';
  assert.match(ENGINE_HARNESS_IMPORTERS.get(file) ?? '', /testkit model/);
  const counts = countLegacyDoubles([
    { file, text: "import { testAgent } from '../../agent-core-v2/test/harness';" },
    { file: 'packages/product/test/other.test.ts', text: "import { testAgent } from '../../agent-core-v2/test/harness';" },
  ]);
  assert.deepEqual(counts, { 'engine-harness-import': { 'packages/product/test/other.test.ts': 1 } });
});

await test('a new legacy Desktop journey is pointed at tests/e2e, not at the paused Desktop fixtures', () => {
  const added = formatReport(compareCounts({}, { 'desktop-stub-model': { 'apps/desktop/e2e/new.spec.ts': 1 } })).join('\n');
  assert.match(added, /instead: write the journey in tests\/e2e/);
  assert.doesNotMatch(added, /fixtures\/app\.ts/);
});

await test('a new legacy double fails with the testkit alternative, and a migrated one asks to lower the baseline', () => {
  const baseline = { 'engine-mock-response': { 'packages/agent-core-v2/test/a.test.ts': 2 } };
  const added = formatReport(compareCounts(baseline, {
    'engine-mock-response': { 'packages/agent-core-v2/test/a.test.ts': 2, 'packages/agent-core-v2/test/b.test.ts': 1 },
  })).join('\n');
  assert.match(added, /engine-mock-response in packages\/agent-core-v2\/test\/b\.test\.ts: 0 → 1/);
  assert.match(added, /instead: build the agent with testkitAgentFixtures\(\)/);
  const removed = formatReport(compareCounts(baseline, {})).join('\n');
  assert.match(removed, /allows more legacy doubles than the tests use/);
  assert.match(removed, /engine-mock-response in packages\/agent-core-v2\/test\/a\.test\.ts: 2 → 0/);
  assert.deepEqual(formatReport(compareCounts(baseline, baseline)), []);
});
