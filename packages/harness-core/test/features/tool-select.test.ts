import { describe, expect, it } from 'vitest';

import {
  createFeature,
  createUserMessage,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  Trees,
  useAgent,
  type AgentHandle,
  type AgentLlmRequester,
  type ToolDefinition,
  type ToolDescription,
} from '@moonshot-ai/agent-core';

import {
  createSelectToolsTool,
  createToolSelect,
  createToolSelectState,
  deferTool,
} from '#/features/tool-select/index';

import { fakeRequester, testModel, textOutcome } from '../fake-llm';

const fakeTool: ToolDefinition = {
  name: 'FakeLoadable',
  description: 'A fake loadable tool.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: () => Promise.resolve({ content: [{ type: 'text', text: 'fake ok' }] }),
};

function captureTools(): { requester: AgentLlmRequester; seen: ToolDescription[][] } {
  const seen: ToolDescription[][] = [];
  return {
    seen,
    requester: fakeRequester((rest, onEvent) => {
      seen.push([...(rest.profile?.tools ?? [])]);
      onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'ok' } });
      onEvent?.({
        type: 'llm.streaming.usage',
        usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
      });
      return textOutcome('ok');
    }),
  };
}

async function openAgent(
  enabled: boolean,
): Promise<{ seen: ToolDescription[][]; main: AgentHandle; dispose: () => Promise<void> }> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  const stores = await openSessionStores(tree, openBlobs(backend.blobs));
  const { requester, seen } = captureTools();
  const bindLlm = createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setModel(testModel);
      agent.setRequester(requester);
    },
  });
  const app = createHarness({
    features: [
      createToolSelect({ loadable: () => [fakeTool], enabled: () => enabled }),
      bindLlm,
    ],
  });
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  return {
    seen,
    main,
    dispose: async () => {
      await app.disposeAsync();
      await stores.dispose();
    },
  };
}

function nextTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

describe('tool-select feature', () => {
  it('registers loadable tools directly and hides select_tools when dynamic loading is disabled', async () => {
    const { seen, main, dispose } = await openAgent(false);
    const done = nextTurnDone(main);
    main.submit(createUserMessage('hi'));
    await done;
    const names = (seen[0] ?? []).map((tool) => tool.name);
    expect(names).toContain('FakeLoadable');
    expect(names).not.toContain('select_tools');
    await dispose();
  });

  it('defers loadable tools behind select_tools when dynamic loading is enabled', async () => {
    const { seen, main, dispose } = await openAgent(true);
    const done = nextTurnDone(main);
    main.submit(createUserMessage('hi'));
    await done;
    const names = (seen[0] ?? []).map((tool) => tool.name);
    expect(names).toContain('select_tools');
    expect(names).not.toContain('FakeLoadable');
    await dispose();
  });

  it('marks select_tools and deferred-tool error results with isError', async () => {
    const state = createToolSelectState({ loadable: () => [fakeTool], enabled: () => true });
    const executeOn = (
      tool: ToolDefinition,
      name: string,
      args: unknown,
    ): ReturnType<ToolDefinition['execute']> =>
      tool.execute({
        toolCall: { type: 'function', id: `call-${name}`, name, arguments: JSON.stringify(args) },
        signal: new AbortController().signal,
      });

    const deferred = deferTool(fakeTool, state);
    const notLoaded = await executeOn(deferred, 'FakeLoadable', {});
    expect(notLoaded.isError).toBe(true);

    const selectTools = createSelectToolsTool(state);
    const emptyNames = await executeOn(selectTools, 'select_tools', { names: [] });
    expect(emptyNames.isError).toBe(true);
    const unknownOnly = await executeOn(selectTools, 'select_tools', { names: ['nope'] });
    expect(unknownOnly.isError).toBe(true);
    const loaded = await executeOn(selectTools, 'select_tools', { names: ['FakeLoadable'] });
    expect(loaded.isError).toBeUndefined();

    const disabled = createSelectToolsTool(
      createToolSelectState({ loadable: () => [fakeTool], enabled: () => false }),
    );
    const unavailable = await executeOn(disabled, 'select_tools', { names: ['FakeLoadable'] });
    expect(unavailable.isError).toBe(true);
  });
});
