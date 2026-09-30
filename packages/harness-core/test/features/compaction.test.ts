import { describe, expect, it } from 'vitest';

import {
  createFeature,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  Trees,
  useAgent,
  type AgentHandle,
  type FeatureSpec,
  type HistoryMessage,
  type AgentLlmRequester,
  type RecordEvent,
  type SessionStores,
  type TurnOutcome,
} from '@moonshot-ai/agent-core';

import {
  CompactError,
  CompactionRef,
  createCompaction,
  type CompactionFace,
  type Summarize,
} from '#/features/compaction/index';

import { failureOutcome, fakeRequester, testModel, textOutcome } from '../fake-llm';

function bindTestLlm(requester: AgentLlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setModel(testModel);
      agent.setRequester(requester);
    },
  });
}

function textOfCalls(calls: string[][]): string[][] {
  return calls;
}

function createEchoRequester(calls?: string[][]): AgentLlmRequester {
  return fakeRequester((rest, onEvent) => {
    const messages = rest.content?.messages ?? [];
    calls?.push(messages.map((message) => extractText(message)));
    const last = messages.at(-1);
    const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
    onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: `echo:${text}` } });
    return textOutcome(`echo:${text}`);
  });
}

function createOverflowRequester(calls: string[][], failTimes: number): AgentLlmRequester {
  let attempt = 0;
  return fakeRequester((rest, onEvent) => {
    const messages = rest.content?.messages ?? [];
    attempt += 1;
    calls.push(messages.map((message) => extractText(message)));
    if (attempt <= failTimes) {
      return failureOutcome({
        kind: 'context_overflow',
        message: 'maximum context length exceeded',
        statusCode: 400,
        requestId: null,
        retryAfterMs: null,
        headers: null,
      });
    }
    const last = messages.at(-1);
    const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
    onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: `echo:${text}` } });
    return textOutcome(`echo:${text}`);
  });
}

function stubSummarize(text: string, onCall?: (history: readonly HistoryMessage[]) => void): Summarize {
  return ({ history, signal }) => {
    onCall?.(history);
    if (signal.aborted) return Promise.reject(signal.reason as unknown);
    return Promise.resolve({ text, attempts: 1, droppedCount: 0 });
  };
}

interface TestEnv {
  stores: SessionStores;
  main: AgentHandle;
  face: CompactionFace;
  dispose: () => Promise<void>;
}

async function startCompactionTest(options: {
  summarize: Summarize;
  budgetMax: () => number;
  maxAutoAttempts?: number;
  requester: AgentLlmRequester;
}): Promise<TestEnv> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  const stores = await openSessionStores(tree, openBlobs(backend.blobs));
  const app = createHarness({
    features: [
      createCompaction({
        summarize: options.summarize,
        budget: { maxContextTokens: options.budgetMax, triggerRatio: 1 },
        maxAutoAttempts: options.maxAutoAttempts,
      }),
      bindTestLlm(options.requester),
    ],
  });
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID });
  await main.ready();
  return {
    stores,
    main,
    face: main.resolve(CompactionRef),
    dispose: async () => {
      await app.disposeAsync();
      await stores.dispose();
    },
  };
}

function turnDone(main: AgentHandle): Promise<TurnOutcome> {
  return new Promise((resolve) => {
    main.on('turn.done', (event) => {
      resolve(event.outcome);
    });
  });
}

async function runTurn(main: AgentHandle, text: string): Promise<void> {
  const done = turnDone(main);
  main.submit(createUserMessage(text));
  await done;
}

function historyOf(stores: SessionStores): HistoryMessage[] {
  return stores.get(MAIN_AGENT_ID)?.getState().history ?? [];
}

describe('compaction feature', () => {
  it('manual compact resets history in place: no remount, no lingering pause, seed with continuation, journal without branch', async () => {
    const env = await startCompactionTest({
      summarize: stubSummarize('SUMMARY'),
      budgetMax: () => 1_000_000,
      requester: createEchoRequester(),
    });
    await runTurn(env.main, 'first');
    await runTurn(env.main, 'second');
    const branchBefore = env.stores.branch(MAIN_AGENT_ID);
    const sessionEvents: RecordEvent[] = [];
    env.stores.session.onCommit((entry) => {
      sessionEvents.push(entry.event);
    });
    const agentEvents: string[] = [];
    env.stores.get(MAIN_AGENT_ID)?.onCommit((entry) => {
      agentEvents.push(entry.event.type as string);
    });

    await expect(env.face.compact('keep decisions')).resolves.toBeUndefined();
    await env.stores.flush();

    expect(env.stores.branch(MAIN_AGENT_ID)).toBe(branchBefore);
    const history = historyOf(env.stores);
    expect(history.map((entry) => entry.message.role)).toEqual(['user', 'user', 'user', 'user']);
    expect(extractText(history[0]?.message ?? { role: 'user', content: [] })).toBe('first');
    expect(extractText(history[1]?.message ?? { role: 'user', content: [] })).toBe('second');
    expect(history[2]?.meta).toMatchObject({ source: 'compaction', key: 'summary' });
    expect(extractText(history[2]?.message ?? { role: 'user', content: [] })).toContain('SUMMARY');
    expect(history[3]?.meta).toMatchObject({ source: 'compaction', key: 'continuation' });
    expect(extractText(history[3]?.message ?? { role: 'user', content: [] })).toContain(
      'Context compaction is complete',
    );

    expect(env.main.snapshot.value?.matches('idle')).toBe(true);
    expect(env.main.snapshot.value?.context.paused).toBe(false);

    const completed = sessionEvents.find((event) => event.type === 'compaction.completed');
    expect(completed).toMatchObject({ type: 'compaction.completed', agentId: 'main' });
    expect(completed !== undefined && 'branch' in completed).toBe(false);
    expect(sessionEvents.some((event) => event.type === 'agent.switched')).toBe(false);
    expect(sessionEvents).toContainEqual(
      expect.objectContaining({ type: 'compaction.started', agentId: 'main', reason: 'manual' }),
    );
    expect(agentEvents).toContain('context.reset');

    await runTurn(env.main, 'third');
    const after = historyOf(env.stores).map((entry) => extractText(entry.message));
    expect(after[0]).toBe('first');
    expect(after.at(-2)).toBe('third');
    expect(after.at(-1)).toBe('echo:third');

    await env.dispose();
  });

  it('budget decision keeps the turn alive: compacting resets in place and the turn finishes done', async () => {
    let budgetMax = 1;
    const calls: string[][] = [];
    const env = await startCompactionTest({
      summarize: stubSummarize('SUMMARY', () => {
        budgetMax = 1_000_000;
      }),
      budgetMax: () => budgetMax,
      requester: createEchoRequester(calls),
    });
    const done = turnDone(env.main);
    env.main.submit(createUserMessage('go'));

    expect((await done).type).toBe('done');
    await env.stores.flush();

    expect(textOfCalls(calls)).toHaveLength(1);
    const request = calls[0] ?? [];
    expect(request).toHaveLength(3);
    expect(request[0]).toBe('go');
    expect(request[1]).toContain('SUMMARY');
    expect(request[2]).toContain('Context compaction is complete');

    const history = historyOf(env.stores);
    expect(history.map((entry) => entry.message.role)).toEqual(['user', 'user', 'user', 'assistant']);
    expect(history[1]?.meta).toMatchObject({ source: 'compaction', key: 'summary' });
    expect(history[2]?.meta).toMatchObject({ source: 'compaction', key: 'continuation' });

    await env.dispose();
  });

  it('context_overflow retries in place: summarize sees the hovering history, second request rides the seed', async () => {
    const calls: string[][] = [];
    const summarized: readonly HistoryMessage[][] = [];
    const env = await startCompactionTest({
      summarize: stubSummarize('SUMMARY', (history) => {
        summarized.push(history);
      }),
      budgetMax: () => 1_000_000,
      requester: createOverflowRequester(calls, 1),
    });
    const done = turnDone(env.main);
    env.main.submit(createUserMessage('go'));

    expect((await done).type).toBe('done');
    await env.stores.flush();

    expect(summarized).toHaveLength(1);
    expect(summarized[0]?.map((entry) => extractText(entry.message))).toEqual(['go']);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['go']);
    expect(calls[1]).toHaveLength(3);
    expect(calls[1]?.[0]).toBe('go');
    expect(calls[1]?.[1]).toContain('SUMMARY');
    expect(calls[1]?.[2]).toContain('Context compaction is complete');

    const history = historyOf(env.stores);
    expect(history.map((entry) => entry.message.role)).toEqual(['user', 'user', 'user', 'assistant']);

    await env.dispose();
  });

  it('fails the turn with attempts-exceeded once auto compaction passes the per-turn cap', async () => {
    const calls: string[][] = [];
    let summarizeCalls = 0;
    const env = await startCompactionTest({
      summarize: stubSummarize('SUMMARY', () => {
        summarizeCalls += 1;
      }),
      budgetMax: () => 1_000_000,
      maxAutoAttempts: 2,
      requester: createOverflowRequester(calls, Number.MAX_SAFE_INTEGER),
    });
    const done = turnDone(env.main);
    env.main.submit(createUserMessage('go'));

    const outcome = await done;
    expect(outcome.type).toBe('failed');
    const failure = outcome.type === 'failed' ? outcome.failure : undefined;
    const error = failure?.reason === 'error' ? failure.error : undefined;
    expect(error).toBeInstanceOf(CompactError);
    expect((error as CompactError).code).toBe('attempts-exceeded');
    expect(summarizeCalls).toBe(2);
    expect(calls).toHaveLength(3);

    await env.dispose();
  });

  it('cancel stops a running manual compact and leaves the agent usable', async () => {
    let notifyStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const summarize: Summarize = ({ signal }) => {
      notifyStarted();
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason as unknown), { once: true });
      });
    };
    const env = await startCompactionTest({
      summarize,
      budgetMax: () => 1_000_000,
      requester: createEchoRequester(),
    });
    await runTurn(env.main, 'first');

    const pending = env.face.compact();
    await started;
    env.face.cancel();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(env.main.snapshot.value?.context.paused).toBe(false);
    expect(env.face.status().phase).toBe('idle');

    await runTurn(env.main, 'after');
    const history = historyOf(env.stores).map((entry) => extractText(entry.message));
    expect(history).toEqual(['first', 'echo:first', 'after', 'echo:after']);

    await env.dispose();
  });
});
