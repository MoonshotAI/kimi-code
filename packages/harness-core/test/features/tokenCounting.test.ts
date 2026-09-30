import { describe, expect, it } from 'vitest';

import {
  ConfigRef,
  createAssistantEntry,
  createAssistantMessage,
  createConfig,
  createFeature,
  createToolEntry,
  createToolMessage,
  createUserEntry,
  createUserMessage,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  Trees,
  UNKNOWN_CAPABILITY,
  useAgent,
  type AgentHandle,
  type AssistantMeta,
  type ConfigPersist,
  type FeatureSpec,
  type HistoryMessage,
  type LlmModel,
  type LlmRequester,
  type SessionStores,
  type TokenUsage,
  type ToolDescription,
} from '@moonshot-ai/agent-core';

import {
  DEFAULT_TOKEN_COUNTING_CONFIG,
  get,
  latestMeasured,
  requestSize,
  statusSize,
  TOKEN_COUNTING_SECTION,
  TOKEN_COUNTING_STRATEGY_ENV,
  tokenCounting,
  tokenCountingConfigSection,
  TokenCountingRef,
} from '#/features/tokenCounting/index';

function usage(inputOther: number, output: number): TokenUsage {
  return { inputOther, output, inputCacheRead: 0, inputCacheCreation: 0 };
}

function userEntry(text: string): HistoryMessage {
  return createUserEntry(createUserMessage(text));
}

function assistantEntry(text: string, usageValue?: TokenUsage): HistoryMessage {
  return createAssistantEntry(createAssistantMessage([{ type: 'text', text }]), {
    usage: usageValue,
  } as AssistantMeta);
}

function toolEntry(text: string): HistoryMessage {
  return createToolEntry(createToolMessage('call-1', text));
}

const anchored: HistoryMessage[] = [
  userEntry('one'),
  assistantEntry('first', usage(100, 50)),
  userEntry('two'),
  toolEntry('result'),
  assistantEntry('later'),
];

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

interface ScriptStep {
  readonly text: string;
  readonly usage?: TokenUsage;
}

let queue: ScriptStep[] = [];

function createMockRequester(): LlmRequester {
  return {
    generate: async (_config, _content, { onEvent }) => {
      const step: ScriptStep = queue.shift() ?? { text: 'done' };
      onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: step.text } });
      if (step.usage !== undefined) {
        onEvent?.({ type: 'llm.streaming.usage', usage: step.usage });
      }
      onEvent?.({ type: 'llm.done' });
    },
  };
}

function bindTestLlm(requester: LlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setConfig({ model });
      agent.setRequester(requester);
    },
  });
}

function fakePersist(): { persist: ConfigPersist } {
  return {
    persist: {
      load: () => Promise.resolve(undefined),
      save: () => Promise.resolve(),
    },
  };
}

async function startTokenCountingTest(options?: {
  readonly env?: Record<string, string | undefined>;
  readonly withConfig?: boolean;
}): Promise<{
  app: ReturnType<typeof createHarness>;
  stores: SessionStores;
  main: AgentHandle;
  runTurn: () => Promise<void>;
  dispose: () => Promise<void>;
}> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  const stores = await openSessionStores(tree, openBlobs(backend.blobs));
  const features: FeatureSpec[] = [
    ...((options?.withConfig ?? true)
      ? [createConfig({ persist: fakePersist().persist, env: options?.env ?? {} })]
      : []),
    tokenCounting,
    bindTestLlm(createMockRequester()),
  ];
  const app = createHarness({ features });
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  await main.ready();
  const runTurn = async (): Promise<void> => {
    const done = new Promise<void>((resolve) => {
      main.on('turn.done', () => {
        resolve();
      });
    });
    main.submit(createUserMessage('go'));
    await done;
    await stores.flush();
  };
  const dispose = async (): Promise<void> => {
    await app.disposeAsync();
    await stores.dispose();
  };
  return { app, stores, main, runTurn, dispose };
}

describe('tokenCounting pure functions', () => {
  it('splits measured and estimated segments around the latest usage anchor', () => {
    expect(get(anchored)).toEqual({ size: 160, measured: 150, estimated: 10 });
    expect(get([userEntry('one'), userEntry('two')])).toEqual({
      size: 4,
      measured: 0,
      estimated: 4,
    });
  });

  it('handles slice ranges including negative indices', () => {
    expect(get(anchored, 2)).toEqual({ size: 10, measured: 0, estimated: 10 });
    expect(get(anchored, -3)).toEqual({ size: 10, measured: 0, estimated: 10 });
    expect(get(anchored, 0, -2)).toEqual({ size: 152, measured: 150, estimated: 2 });
    expect(get(anchored, 0, 1)).toEqual({ size: 2, measured: 2, estimated: 0 });
    expect(get(anchored, 3, 99)).toEqual({ size: 8, measured: 0, estimated: 8 });
  });

  it('latestMeasured returns the last anchor tokens and skips empty usage', () => {
    expect(latestMeasured(anchored)).toBe(150);
    expect(
      latestMeasured([
        userEntry('one'),
        assistantEntry('first', usage(100, 50)),
        assistantEntry('later', usage(0, 0)),
      ]),
    ).toBe(150);
    expect(latestMeasured([userEntry('one')])).toBe(0);
  });

  it('statusSize follows the strategy', () => {
    expect(statusSize(anchored, 'measured')).toBe(150);
    expect(statusSize(anchored, 'estimated')).toBe(17);
    expect(statusSize(anchored, 'measured+estimated')).toBe(160);
  });

  it('requestSize estimates the system prompt, tools, and messages', () => {
    const tools: ToolDescription[] = [
      { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: {} } },
    ];
    expect(
      requestSize({
        systemPrompt: 'you are helpful',
        tools,
        messages: [createUserMessage('one'), createAssistantMessage([{ type: 'text', text: 'first' }])],
      }),
    ).toBe(34);
    expect(requestSize({ systemPrompt: '', tools: [], messages: [] })).toBe(1);
  });

  it('anchors follow history truncation', () => {
    const full: HistoryMessage[] = [
      userEntry('one'),
      assistantEntry('first', usage(100, 50)),
      userEntry('two'),
      assistantEntry('second', usage(120, 40)),
    ];
    expect(statusSize(full, 'measured+estimated')).toBe(160);
    expect(statusSize(full.slice(0, 2), 'measured+estimated')).toBe(150);
    expect(statusSize(full.slice(0, 1), 'measured+estimated')).toBe(2);
  });

  it('degrades to pure estimation when assistant entries are removed', () => {
    const compacted = anchored.filter((entry) => entry.message.role !== 'assistant');
    expect(latestMeasured(compacted)).toBe(0);
    expect(statusSize(compacted, 'measured+estimated')).toBe(7);
  });
});

describe('tokenCounting feature', () => {
  it('exposes a facade whose reads reflect the current history without config', async () => {
    queue = [
      { text: 'first', usage: usage(100, 50) },
      { text: 'second' },
    ];
    const env = await startTokenCountingTest({ withConfig: false });
    const face = env.main.resolve(TokenCountingRef);

    await env.runTurn();
    expect(face.get()).toEqual({ size: 150, measured: 150, estimated: 0 });
    expect(face.statusSize()).toBe(150);
    expect(face.latestMeasured()).toBe(150);

    await env.runTurn();
    expect(face.get()).toEqual({ size: 157, measured: 150, estimated: 7 });
    expect(face.statusSize()).toBe(157);
    expect(face.latestMeasured()).toBe(150);
    await env.dispose();
  });

  it('initializes the status ref on mount and recomputes it after turn.ended', async () => {
    queue = [
      { text: 'first', usage: usage(100, 50) },
      { text: 'second' },
    ];
    const env = await startTokenCountingTest({ withConfig: false });
    const face = env.main.resolve(TokenCountingRef);
    expect(face.status.value).toBe(0);

    await env.runTurn();
    expect(face.status.value).toBe(150);

    await env.runTurn();
    expect(face.status.value).toBe(157);
    await env.dispose();
  });

  it('registers the tokenCounting config section with defaults and strips env fields', async () => {
    const env = await startTokenCountingTest();
    expect(env.app.resolve(ConfigRef).get(TOKEN_COUNTING_SECTION)).toEqual(
      DEFAULT_TOKEN_COUNTING_CONFIG,
    );
    expect(
      tokenCountingConfigSection.stripEnv?.({ strategy: 'measured' }, undefined, () => undefined),
    ).toEqual({ strategy: 'measured' });
    expect(
      tokenCountingConfigSection.stripEnv?.({ strategy: 'measured' }, undefined, (name) =>
        name === TOKEN_COUNTING_STRATEGY_ENV ? 'measured' : undefined,
      ),
    ).toBeUndefined();
    await env.dispose();
  });

  it('applies the KIMI_TOKEN_COUNTING_STRATEGY env binding', async () => {
    queue = [
      { text: 'first', usage: usage(100, 50) },
      { text: 'second' },
    ];
    const measured = await startTokenCountingTest({
      env: { KIMI_TOKEN_COUNTING_STRATEGY: ' MEASURED ' },
    });
    expect(measured.app.resolve(ConfigRef).get(TOKEN_COUNTING_SECTION)).toEqual({
      strategy: 'measured',
    });
    await measured.runTurn();
    await measured.runTurn();
    expect(measured.main.resolve(TokenCountingRef).statusSize()).toBe(150);
    await measured.dispose();

    queue = [
      { text: 'first', usage: usage(100, 50) },
      { text: 'second' },
    ];
    const estimated = await startTokenCountingTest({
      env: { KIMI_TOKEN_COUNTING_STRATEGY: 'estimated' },
    });
    await estimated.runTurn();
    await estimated.runTurn();
    expect(estimated.main.resolve(TokenCountingRef).statusSize()).toBe(14);
    await estimated.dispose();
  });

  it('falls back to the default strategy for an invalid env value', async () => {
    queue = [
      { text: 'first', usage: usage(100, 50) },
      { text: 'second' },
    ];
    const env = await startTokenCountingTest({
      env: { KIMI_TOKEN_COUNTING_STRATEGY: 'bogus' },
    });
    expect(env.app.resolve(ConfigRef).get(TOKEN_COUNTING_SECTION)).toEqual(
      DEFAULT_TOKEN_COUNTING_CONFIG,
    );
    await env.runTurn();
    await env.runTurn();
    expect(env.main.resolve(TokenCountingRef).statusSize()).toBe(157);
    await env.dispose();
  });
});
