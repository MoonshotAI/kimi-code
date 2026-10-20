import { describe, expect, it } from 'vitest';

import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry, type HistoryMessage } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import { createAssistantMessage, createUserMessage, extractText } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import type { Agent, Session } from '@moonshot-ai/agent-core/session/index';

import {
  CompactionRef,
  createCompaction,
  isContextOverflowError,
  type CompactionCompletedEvent,
  type CompactionEvent,
  type CompactionFace,
  type Summarize,
} from '#/features/compaction/index';
import { createHarness, harnessInternals, memoryHarnessSpace, type Harness } from '#/runtime/index';

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

function textOutcome(text: string): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }]) };
}

function scriptedRequester(next: (rest: GenerateRest) => LlmOutcome | Promise<LlmOutcome>): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest, _control) => next(rest),
  };
  return self;
}

function echoRequester(calls?: string[][]): LoopLlmRequester {
  return scriptedRequester((rest) => {
    const messages = rest.content?.messages ?? [];
    calls?.push(messages.map((message) => extractText(message)));
    const last = messages.at(-1);
    const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
    return textOutcome(`echo:${text}`);
  });
}

function overflowRequester(calls: string[][], failTimes: number): LoopLlmRequester {
  let attempt = 0;
  return scriptedRequester((rest) => {
    const messages = rest.content?.messages ?? [];
    attempt += 1;
    calls.push(messages.map((message) => extractText(message)));
    if (attempt <= failTimes) {
      return {
        type: 'failed',
        error: {
          kind: 'context_overflow',
          message: 'maximum context length exceeded',
          statusCode: 400,
          requestId: null,
          retryAfterMs: null,
          headers: null,
        },
      };
    }
    const last = messages.at(-1);
    const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
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

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

interface TestEnv {
  harness: Harness;
  session: Session;
  agent: Agent;
  feature: Feature<void, CompactionEvent>;
  face: () => CompactionFace | undefined;
  events: CompactionEvent[];
  dispose: () => Promise<void>;
}

async function startCompactionTest(options: {
  summarize?: Summarize;
  budgetMax: () => number;
  maxAutoAttempts?: number;
  requester: LoopLlmRequester;
}): Promise<TestEnv> {
  const harness = createHarness({ space: memoryHarnessSpace() });
  const events: CompactionEvent[] = [];
  const feature = createCompaction({
    summarize: options.summarize,
    budget: { maxContextTokens: options.budgetMax, triggerRatio: 1 },
    maxAutoAttempts: options.maxAutoAttempts,
    onEvent: (event) => events.push(event),
  });
  await harness.app.features.add(feature);
  let face: Readonly<ShallowRef<CompactionFace | undefined>> | undefined;
  const probe = createFeature('compaction-probe', {
    agent: () => {
      face = useInject(CompactionRef);
    },
  });
  await harness.app.features.add(probe);
  const session = await harness.app.create({ sessionId: 's1' });
  const agent = await harness.ensureAgent(session, 'main');
  setRequester(harness, 's1', 'main', options.requester);
  return {
    harness,
    session,
    agent,
    feature,
    face: () => face?.value,
    events,
    dispose: () => harness.close(),
  };
}

describe('compaction feature', () => {
  it('manual compact rewrites context in place: seed with continuation, durable context.settled, agent stays usable', async () => {
    const env = await startCompactionTest({
      summarize: stubSummarize('SUMMARY'),
      budgetMax: () => 1_000_000,
      requester: echoRequester(),
    });
    const fired: CompactionCompletedEvent[] = [];
    env.harness.app.on(env.feature, 'compaction.completed', (event) => {
      fired.push(event);
    });
    await env.agent.loop.runTurn(user('first'));
    await env.agent.loop.runTurn(user('second'));

    await expect(env.face()?.compact('keep decisions')).resolves.toBeUndefined();
    await env.agent.flush();

    const history = env.agent.view.getState().messages;
    expect(history.map((entry) => entry.message.role)).toEqual(['user', 'user', 'user', 'user']);
    expect(extractText(history[0]!.message)).toBe('first');
    expect(extractText(history[1]!.message)).toBe('second');
    expect(history[2]?.meta).toMatchObject({ source: 'compaction', key: 'summary' });
    expect(extractText(history[2]!.message)).toContain('SUMMARY');
    expect(history[3]?.meta).toMatchObject({ source: 'compaction', key: 'continuation' });
    expect(extractText(history[3]!.message)).toContain('Context compaction is complete');

    expect(env.agent.loop.state.status).toBe('idle');
    expect(env.agent.loop.state.turn).toBeUndefined();
    expect(env.face()?.status().phase).toBe('idle');

    expect(env.events.map((event) => event.type)).toEqual(['compaction.started', 'compaction.completed']);
    expect(env.events[0]).toMatchObject({ reason: 'manual', instruction: 'keep decisions' });
    expect(env.events[1]).toMatchObject({ type: 'compaction.completed', reason: 'manual' });
    expect(fired).toHaveLength(1);

    const records = env.agent.log.replica.entries().map((entry) => entry.event);
    expect(records.some((event) => event.type === 'context.settled')).toBe(true);

    await env.agent.loop.runTurn(user('third'));
    await env.agent.flush();
    const after = env.agent.view.getState().messages.map((entry) => extractText(entry.message));
    expect(after[0]).toBe('first');
    expect(after.at(-2)).toBe('third');
    expect(after.at(-1)).toBe('echo:third');

    await env.dispose();
  });

  it('budget excess compacts inside step.starting and the turn finishes done on the seed', async () => {
    let budgetMax = 1;
    const calls: string[][] = [];
    const env = await startCompactionTest({
      summarize: stubSummarize('SUMMARY', () => {
        budgetMax = 1_000_000;
      }),
      budgetMax: () => budgetMax,
      requester: echoRequester(calls),
    });

    const outcome = await env.agent.loop.runTurn(user('go'));
    expect(outcome.type).toBe('done');
    await env.agent.flush();

    expect(calls).toHaveLength(1);
    const request = calls[0]!;
    expect(request).toHaveLength(3);
    expect(request[0]).toBe('go');
    expect(request[1]).toContain('SUMMARY');
    expect(request[2]).toContain('Context compaction is complete');

    const history = env.agent.view.getState().messages;
    expect(history.map((entry) => entry.message.role)).toEqual(['user', 'user', 'user', 'assistant']);
    expect(history[1]?.meta).toMatchObject({ source: 'compaction', key: 'summary' });
    expect(history[2]?.meta).toMatchObject({ source: 'compaction', key: 'continuation' });
    expect(env.events.map((event) => event.type)).toEqual(['compaction.started', 'compaction.completed']);
    expect(env.events[0]).toMatchObject({ reason: 'budget' });

    await env.dispose();
  });

  it('context_overflow compacts and retries in place: summarize sees the hovering history, second request rides the seed', async () => {
    const calls: string[][] = [];
    const summarized: HistoryMessage[][] = [];
    const env = await startCompactionTest({
      summarize: stubSummarize('SUMMARY', (history) => {
        summarized.push([...history]);
      }),
      budgetMax: () => 1_000_000,
      requester: overflowRequester(calls, 1),
    });

    const outcome = await env.agent.loop.runTurn(user('go'));
    expect(outcome.type).toBe('done');
    await env.agent.flush();

    expect(summarized).toHaveLength(1);
    expect(summarized[0]!.map((entry) => extractText(entry.message))).toEqual(['go']);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['go']);
    expect(calls[1]).toHaveLength(3);
    expect(calls[1]![0]).toBe('go');
    expect(calls[1]![1]).toContain('SUMMARY');
    expect(calls[1]![2]).toContain('Context compaction is complete');

    const history = env.agent.view.getState().messages;
    expect(history.map((entry) => entry.message.role)).toEqual(['user', 'user', 'user', 'assistant']);
    expect(env.events.map((event) => event.type)).toEqual(['compaction.started', 'compaction.completed']);
    expect(env.events[0]).toMatchObject({ reason: 'overflow' });

    await env.dispose();
  });

  it('fails the turn once auto compaction passes the per-turn cap', async () => {
    const calls: string[][] = [];
    let summarizeCalls = 0;
    const env = await startCompactionTest({
      summarize: stubSummarize('SUMMARY', () => {
        summarizeCalls += 1;
      }),
      budgetMax: () => 1_000_000,
      maxAutoAttempts: 2,
      requester: overflowRequester(calls, Number.MAX_SAFE_INTEGER),
    });

    const outcome = await env.agent.loop.runTurn(user('go'));
    expect(outcome.type).toBe('failed');
    const error = outcome.type === 'failed' ? outcome.error : undefined;
    expect(isContextOverflowError(error)).toBe(true);
    expect(summarizeCalls).toBe(2);
    expect(calls).toHaveLength(3);
    expect(env.events.filter((event) => event.type === 'compaction.started')).toHaveLength(2);

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
      requester: echoRequester(),
    });
    await env.agent.loop.runTurn(user('first'));

    const pending = env.face()!.compact();
    await started;
    env.face()!.cancel();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(env.face()?.status().phase).toBe('idle');
    expect(env.agent.loop.state.turn).toBeUndefined();

    await env.agent.loop.runTurn(user('after'));
    await env.agent.flush();
    const history = env.agent.view.getState().messages.map((entry) => extractText(entry.message));
    expect(history).toEqual(['first', 'echo:first', 'after', 'echo:after']);
    expect(env.events.map((event) => event.type)).toEqual(['compaction.started', 'compaction.cancelled']);
    expect(env.events[1]).toMatchObject({ reason: 'manual', cause: 'cancelled' });

    await env.dispose();
  });

  it('default summarize rides the loop requester: instruction prompt, empty tools, seed lands in history', async () => {
    let budgetMax = 1;
    const calls: { messages: string[]; tools: unknown }[] = [];
    const requester = scriptedRequester((rest) => {
      const messages = rest.content?.messages ?? [];
      calls.push({
        messages: messages.map((message) => extractText(message)),
        tools: rest.profile?.tools,
      });
      if (calls.length === 1) {
        budgetMax = 1_000_000;
        return textOutcome('SUMMARY FROM MODEL');
      }
      const last = messages.at(-1);
      const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
      return textOutcome(`echo:${text}`);
    });
    const env = await startCompactionTest({
      budgetMax: () => budgetMax,
      requester,
    });

    const outcome = await env.agent.loop.runTurn(user('go'));
    expect(outcome.type).toBe('done');
    await env.agent.flush();

    expect(calls).toHaveLength(2);
    expect(calls[0]!.messages[0]).toBe('go');
    expect(calls[0]!.messages.at(-1)).toContain('You are about to run out of context');
    expect(calls[0]!.tools).toEqual([]);
    expect(calls[1]!.messages[0]).toBe('go');
    expect(calls[1]!.messages[1]).toContain('SUMMARY FROM MODEL');
    expect(calls[1]!.messages[2]).toContain('Context compaction is complete');

    const history = env.agent.view.getState().messages;
    expect(history.map((entry) => entry.message.role)).toEqual(['user', 'user', 'user', 'assistant']);
    expect(history[1]?.meta).toMatchObject({ source: 'compaction', key: 'summary' });
    expect(extractText(history[1]!.message)).toContain('SUMMARY FROM MODEL');

    await env.dispose();
  });
});
