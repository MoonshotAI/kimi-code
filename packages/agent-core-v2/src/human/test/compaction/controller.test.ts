import { describe, expect, it, vi } from 'vitest';

import { createAgentMachine, type AgentMachineContext } from '#/agent/machine';
import { messageAppended } from '#/agent/events';
import type { AgentEventStore } from '#/agent/slices';
import { createTurnMachine, createUserEntry, type TurnBeforeStep } from '#/agent/turn';
import { createCompactionController, type CompactionEvent } from '#/compaction/controller';
import type { Summarize, SummaryOutcome } from '#/compaction/summarize';
import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createUserMessage, extractText } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { createLlmMachine } from '#/llm/requester/machine';
import type { LlmRequestConfig, LlmRequester } from '#/llm/requester/requester';
import { SessionStores } from '#/session/stores';
import { MemoryBackend } from '#/store/backend/memory';
import { TreeStore } from '#/store/store';
import type { Tree } from '#/store/tree';
import { createActor, waitFor, type ActorRefFrom } from '#/xstate2';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

type AgentActor = ActorRefFrom<ReturnType<typeof createAgentMachine>>;

interface TestEnv {
  backend: MemoryBackend;
  tree: Tree;
  stores: SessionStores;
}

async function testEnv(): Promise<TestEnv> {
  const backend = new MemoryBackend();
  const store = await TreeStore.open(backend, {});
  const tree = await store.tree('sess');
  return { backend, tree, stores: new SessionStores(tree, backend) };
}

interface BeforeStepHook {
  current?: TurnBeforeStep;
}

function startAgent(
  store: AgentEventStore,
  requester: LlmRequester,
  beforeStep?: BeforeStepHook,
  request?: Partial<LlmRequestConfig>,
): AgentActor {
  const actor = createActor(
    createAgentMachine({
      tools: [],
      turnActor: createTurnMachine(createLlmMachine({ requester }), {
        onBeforeStep: (context) => beforeStep?.current?.(context),
      }),
    }),
    { input: { request: { model, ...request }, store } },
  );
  actor.start();
  return actor;
}

function createEchoRequester(): LlmRequester {
  return {
    generate: (_config, { messages }, { onEvent }) => {
      const last = messages.at(-1);
      const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
      onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: `echo:${text}` } });
      onEvent?.({ type: 'llm.done' });
      return Promise.resolve();
    },
  };
}

function createOverflowRequester(): LlmRequester {
  return {
    generate: (_config, _content, { onEvent }) => {
      onEvent?.({
        type: 'llm.failed.remote',
        error: {
          kind: 'context_overflow',
          message: 'maximum context length exceeded',
          statusCode: 400,
          requestId: null,
          retryAfterMs: null,
          headers: null,
        },
      });
      return Promise.resolve();
    },
  };
}

interface ControllerHarness {
  controller: ReturnType<typeof createCompactionController>;
  events: CompactionEvent[];
  summarizeCalls: { historyLength: number; instruction?: string }[];
}

function startController(
  env: TestEnv,
  actor: AgentActor,
  overrides?: Partial<Parameters<typeof createCompactionController>[0]>,
): ControllerHarness {
  const events: CompactionEvent[] = [];
  const summarizeCalls: { historyLength: number; instruction?: string }[] = [];
  const summarize: Summarize = async ({ history, instruction }) => {
    summarizeCalls.push({ historyLength: history.length, instruction });
    return { text: 'SUMMARY TEXT', attempts: 1, droppedCount: 0 };
  };
  const controller = createCompactionController({
    agentId: 'main',
    actor,
    stores: env.stores,
    summarize,
    budget: { maxContextTokens: () => 2000, triggerRatio: 0.85 },
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { controller, events, summarizeCalls };
}

function historyTexts(store: AgentEventStore): string[] {
  return store.getState().history.map((entry) => extractText(entry.message));
}

describe('compaction controller manual', () => {
  it('compacts an idle agent onto a fresh branch and blocks undo across the switch', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const actor = startAgent(main, createEchoRequester());
    actor.send({ type: 'input.submit', message: createUserMessage('first') });
    await waitFor(actor, (s) => s.matches('idle') && main.getState().history.length === 2, {
      timeout: 5000,
    });
    const willCompactInputs: { tokenCount: number }[] = [];
    const harness = startController(env, actor, {
      onWillCompact: (input) => {
        willCompactInputs.push(input);
      },
    });

    const result = await harness.controller.compact();

    expect(result.branchId).toBe('main~2');
    expect(main.ref.branch).toBe('main~2');
    const texts = historyTexts(main);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe('first');
    expect(texts[1]).toContain('SUMMARY TEXT');
    expect(main.getState().turnIndex.turns).toHaveLength(1);
    expect(main.getState().turnIndex.nextTurnId).toBe(2);
    expect(env.tree.openBranch('main~2').header.parentBranch).toBeUndefined();
    expect((await env.stores.session()).getState().roster.agents['main']).toBe('main~2');
    await expect(env.stores.undo('main', 1)).rejects.toMatchObject({ reason: 'insufficient' });
    const sessionBranch = env.tree.openBranch('_session');
    const sessionTypes: string[] = [];
    for (let seq = 0; seq <= (sessionBranch.head ?? -1); seq++) {
      const entry = sessionBranch.entryAt(seq);
      if (entry !== null) sessionTypes.push(entry.type);
    }
    expect(sessionTypes).toEqual([
      'agent.opened',
      'compaction.started',
      'agent.switched',
      'compaction.completed',
    ]);
    expect(harness.controller.status()).toEqual({ phase: 'idle' });
    expect(harness.summarizeCalls).toEqual([{ historyLength: 2, instruction: undefined }]);
    expect(harness.events.map((event) => event.type)).toEqual([
      'compaction.started',
      'compaction.completed',
    ]);
    const completed = harness.events.at(-1);
    expect(completed?.type === 'compaction.completed' && completed.reason === 'manual').toBe(true);
    expect(
      completed?.type === 'compaction.completed' &&
        completed.originTurnId === undefined &&
        completed.summary?.attempts === 1 &&
        completed.summary?.droppedCount === 0,
    ).toBe(true);
    expect(willCompactInputs).toHaveLength(1);
    expect(willCompactInputs[0]?.tokenCount).toBeGreaterThan(0);
    expect(actor.getSnapshot().matches('idle')).toBe(true);
    expect((actor.getSnapshot().context as AgentMachineContext).messages).toHaveLength(2);
    await env.stores.flush();
    expect(main.getState().history).toHaveLength(2);

    harness.controller.dispose();
    actor.stop();
  });

  it('pauses a running turn at the step boundary and preserves queued inputs through the switch', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    let release: (() => void) | undefined;
    let first = true;
    const requester: LlmRequester = {
      generate: (_config, { messages }, { onEvent }) => {
        const last = messages.at(-1);
        const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
        const respond = (): void => {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: `echo:${text}` } });
          onEvent?.({ type: 'llm.done' });
        };
        if (!first) {
          respond();
          return Promise.resolve();
        }
        first = false;
        return new Promise<void>((resolve) => {
          release = () => {
            respond();
            resolve();
          };
        });
      },
    };
    const actor = startAgent(main, requester);
    actor.send({ type: 'input.submit', message: createUserMessage('first') });
    await waitFor(actor, (s) => s.matches('running'), { timeout: 5000 });
    actor.send({ type: 'input.submit', message: createUserMessage('q1') });
    actor.send({ type: 'input.submit', message: createUserMessage('q2') });
    await vi.waitFor(() => expect(main.getState().queue).toHaveLength(2), { timeout: 5000 });
    const harness = startController(env, actor);

    const compactPromise = harness.controller.compact();
    await vi.waitFor(() => expect(actor.getSnapshot().context.paused).toBe(true), { timeout: 5000 });
    (release as () => void)();

    const result = await compactPromise;
    expect(result.branchId).toBe('main~2');
    await waitFor(actor, (s) => s.matches('idle') && main.getState().history.length === 6, {
      timeout: 5000,
    });

    const texts = historyTexts(main);
    expect(texts[0]).toBe('first');
    expect(texts[1]).toContain('SUMMARY TEXT');
    expect(texts.slice(2)).toEqual(['q1', 'echo:q1', 'q2', 'echo:q2']);
    expect(main.getState().turnIndex.nextTurnId).toBe(4);
    expect(harness.summarizeCalls[0]?.historyLength).toBe(2);

    harness.controller.dispose();
    actor.stop();
  });

  it('merges inputs submitted and steered during summarization into the new branch', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const actor = startAgent(main, createEchoRequester());
    actor.send({ type: 'input.submit', message: createUserMessage('first') });
    await waitFor(actor, (s) => s.matches('idle') && main.getState().history.length === 2, {
      timeout: 5000,
    });
    let resolveSummary: ((outcome: SummaryOutcome) => void) | undefined;
    let summaryCalled = false;
    const summarize: Summarize = () => {
      summaryCalled = true;
      return new Promise<SummaryOutcome>((resolve) => {
        resolveSummary = resolve;
      });
    };
    const harness = startController(env, actor, { summarize });

    const compactPromise = harness.controller.compact();
    await vi.waitFor(() => expect(summaryCalled).toBe(true), { timeout: 5000 });
    expect(harness.controller.status().phase).toBe('summarizing');
    actor.send({ type: 'input.submit', id: 's1', message: createUserMessage('late') });
    actor.send({ type: 'input.submit', message: createUserMessage('queued') });
    await vi.waitFor(() => expect(main.getState().queue).toHaveLength(2), { timeout: 5000 });
    actor.send({ type: 'input.steer', id: 's1' });
    await vi.waitFor(() => expect(main.getState().notifications).toHaveLength(1), { timeout: 5000 });
    (resolveSummary as (outcome: SummaryOutcome) => void)({
      text: 'MERGED SUMMARY',
      attempts: 1,
      droppedCount: 0,
    });

    const result = await compactPromise;
    expect(result.branchId).toBe('main~2');
    await waitFor(actor, (s) => s.matches('idle') && main.getState().history.length === 5, {
      timeout: 5000,
    });

    expect(historyTexts(main)).toEqual([
      'first',
      expect.stringContaining('MERGED SUMMARY'),
      'late',
      'queued',
      'echo:queued',
    ]);
    expect(main.getState().turnIndex.nextTurnId).toBe(3);
    expect(harness.events.map((event) => event.type)).toEqual([
      'compaction.started',
      'compaction.completed',
    ]);

    harness.controller.dispose();
    actor.stop();
  });

  it('cancels an in-flight compaction via cancel() and releases the pause', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const actor = startAgent(main, createEchoRequester());
    actor.send({ type: 'input.submit', message: createUserMessage('first') });
    await waitFor(actor, (s) => s.matches('idle') && main.getState().history.length === 2, {
      timeout: 5000,
    });
    const summarize: Summarize = ({ signal }) =>
      new Promise<SummaryOutcome>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const harness = startController(env, actor, { summarize });

    const compactPromise = harness.controller.compact();
    await vi.waitFor(() => expect(harness.controller.status().phase).toBe('summarizing'), {
      timeout: 5000,
    });
    actor.send({ type: 'input.submit', message: createUserMessage('while-compacting') });
    harness.controller.cancel();

    await expect(compactPromise).rejects.toMatchObject({ code: 'cancelled' });
    await waitFor(actor, (s) => s.matches('idle') && main.getState().history.length === 4, {
      timeout: 5000,
    });
    expect(main.ref.branch).toBe('main');
    expect(env.tree.has('main~2')).toBe(false);
    expect(historyTexts(main)).toEqual([
      'first',
      'echo:first',
      'while-compacting',
      'echo:while-compacting',
    ]);
    expect(harness.events.map((event) => event.type)).toEqual([
      'compaction.started',
      'compaction.cancelled',
    ]);
    const cancelled = harness.events.at(-1);
    expect(cancelled?.type === 'compaction.cancelled' && cancelled.cause === 'cancelled').toBe(true);
    expect(
      cancelled?.type === 'compaction.cancelled' &&
        typeof cancelled.tokensBefore === 'number' &&
        cancelled.tokensBefore > 0,
    ).toBe(true);
    expect(harness.controller.status()).toEqual({ phase: 'idle' });

    harness.controller.dispose();
    actor.stop();
  });

  it('cancels the compaction when the user aborts during quiesce and stays paused until resumed', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    let first = true;
    const requester: LlmRequester = {
      generate: (_config, { messages }, { onEvent }) => {
        const last = messages.at(-1);
        const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
        if (!first) {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: `echo:${text}` } });
          onEvent?.({ type: 'llm.done' });
          return Promise.resolve();
        }
        first = false;
        return new Promise<void>(() => undefined);
      },
    };
    const actor = startAgent(main, requester);
    actor.send({ type: 'input.submit', message: createUserMessage('first') });
    await waitFor(actor, (s) => s.matches('running'), { timeout: 5000 });
    const harness = startController(env, actor);

    const compactPromise = harness.controller.compact();
    await vi.waitFor(() => expect(actor.getSnapshot().context.paused).toBe(true), { timeout: 5000 });
    expect(harness.controller.status().phase).toBe('quiescing');
    actor.send({ type: 'input.abort' });

    await expect(compactPromise).rejects.toMatchObject({ code: 'aborted' });
    await waitFor(actor, (s) => s.matches('idle'), { timeout: 5000 });
    expect(harness.events.map((event) => event.type)).toEqual([
      'compaction.started',
      'compaction.blocked',
      'compaction.cancelled',
    ]);
    const cancelled = harness.events.at(-1);
    expect(cancelled?.type === 'compaction.cancelled' && cancelled.cause === 'user-abort').toBe(true);

    actor.send({ type: 'input.submit', message: createUserMessage('later') });
    await vi.waitFor(() => expect(main.getState().queue).toHaveLength(1), { timeout: 5000 });
    expect(actor.getSnapshot().matches('idle')).toBe(true);
    expect(actor.getSnapshot().context.paused).toBe(true);
    expect(historyTexts(main)).toEqual(['first']);

    actor.send({ type: 'input.continue' });
    await waitFor(actor, (s) => s.matches('idle') && main.getState().history.length === 3, {
      timeout: 5000,
    });
    expect(historyTexts(main)).toEqual(['first', 'later', 'echo:later']);
    expect(harness.controller.status()).toEqual({ phase: 'idle' });

    harness.controller.dispose();
    actor.stop();
  });

  it('cancels the compaction when non-input entries land on the branch during summarization', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const actor = startAgent(main, createEchoRequester());
    actor.send({ type: 'input.submit', message: createUserMessage('first') });
    await waitFor(actor, (s) => s.matches('idle') && main.getState().history.length === 2, {
      timeout: 5000,
    });
    let resolveSummary: ((outcome: SummaryOutcome) => void) | undefined;
    let summaryCalled = false;
    const summarize: Summarize = () => {
      summaryCalled = true;
      return new Promise<SummaryOutcome>((resolve) => {
        resolveSummary = resolve;
      });
    };
    const harness = startController(env, actor, { summarize });

    const compactPromise = harness.controller.compact();
    await vi.waitFor(() => expect(summaryCalled).toBe(true), { timeout: 5000 });
    await main.dispatch([
      messageAppended({ message: createUserEntry(createUserMessage('foreign'), { source: 'input' }) }),
    ]);
    (resolveSummary as (outcome: SummaryOutcome) => void)({ text: 'TOO LATE', attempts: 1, droppedCount: 0 });

    await expect(compactPromise).rejects.toMatchObject({ code: 'drift' });
    expect(main.ref.branch).toBe('main');
    expect(env.tree.has('main~2')).toBe(false);
    expect(harness.events.map((event) => event.type)).toEqual([
      'compaction.started',
      'compaction.cancelled',
    ]);
    const cancelled = harness.events.at(-1);
    expect(cancelled?.type === 'compaction.cancelled' && cancelled.cause === 'drift').toBe(true);

    harness.controller.dispose();
    actor.stop();
  });
});

describe('compaction controller auto', () => {
  it('blocks an over-budget step before the request is sent, compacts, then resumes', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const seen: string[] = [];
    const requester: LlmRequester = {
      generate: (_config, { messages }, { onEvent }) => {
        const last = messages.at(-1);
        const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
        seen.push(text);
        const reply = text === 'big' ? 'R'.repeat(2600) : `echo:${text}`;
        onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: reply } });
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      },
    };
    const beforeStep: BeforeStepHook = {};
    const actor = startAgent(main, requester, beforeStep, { systemPrompt: 'S'.repeat(4400) });
    const harness = startController(env, actor);
    beforeStep.current = harness.controller.onBeforeStep;

    actor.send({ type: 'input.submit', message: createUserMessage('big') });
    await waitFor(actor, (s) => s.matches('idle') && main.getState().history.length === 2, {
      timeout: 5000,
    });
    expect(seen).toEqual(['big']);

    actor.send({ type: 'input.submit', message: createUserMessage('next') });
    await vi.waitFor(
      () => {
        expect(harness.events.filter((event) => event.type === 'compaction.completed')).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    await waitFor(actor, (s) => s.matches('idle') && main.getState().history.length === 5, {
      timeout: 5000,
    });

    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('Context compaction is complete');
    expect(main.ref.branch).toBe('main~2');
    const texts = historyTexts(main);
    expect(texts[0]).toBe('big');
    expect(texts[1]).toBe('next');
    expect(texts[2]).toContain('SUMMARY TEXT');
    expect(texts[3]).toContain('Context compaction is complete');
    expect(texts[4]).toContain('echo:');
    expect(main.getState().turnIndex.nextTurnId).toBe(4);
    expect(harness.events.map((event) => event.type)).toEqual([
      'compaction.started',
      'compaction.blocked',
      'compaction.completed',
    ]);
    const completed = harness.events.at(-1);
    expect(completed?.type === 'compaction.completed' && completed.originTurnId === 1).toBe(true);
    await env.stores.flush();
    expect(main.getState().history).toHaveLength(5);
    expect(harness.events.filter((event) => event.type === 'compaction.started')).toHaveLength(1);

    harness.controller.dispose();
    actor.stop();
  });

  it('recovers from overflow turns up to the attempt cap, then surfaces the failure', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const beforeStep: BeforeStepHook = {};
    const actor = startAgent(main, createOverflowRequester(), beforeStep);
    let failedCount = 0;
    actor.on('turn.failed', () => {
      failedCount += 1;
    });
    const harness = startController(env, actor, { maxAutoAttempts: 2 });
    beforeStep.current = harness.controller.onBeforeStep;

    actor.send({ type: 'input.submit', message: createUserMessage('go') });
    await vi.waitFor(() => expect(failedCount).toBe(3), { timeout: 5000 });
    await vi.waitFor(
      () => {
        expect(harness.events.filter((event) => event.type === 'compaction.completed')).toHaveLength(2);
      },
      { timeout: 5000 },
    );
    await waitFor(actor, (s) => s.matches('idle'), { timeout: 5000 });

    expect(harness.summarizeCalls).toHaveLength(2);
    expect(main.ref.branch).toBe('main~3');
    expect(harness.events.map((event) => event.type)).toEqual([
      'compaction.started',
      'compaction.completed',
      'compaction.started',
      'compaction.completed',
    ]);

    harness.controller.dispose();
    actor.stop();
  });
});
