import { describe, expect, it } from 'vitest';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry, type HistoryMessage, type UserMeta } from '@moonshot-ai/agent-core/history/index';
import { createAssistantMessage, createUserMessage, extractText, type ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import type { Projection } from '@moonshot-ai/agent-core/store/index';

import { agentCaps } from '#/runtime/agents';
import { createHarness, harnessInternals, memoryHarnessSpace, type Harness } from '#/runtime/harness';
import { useAgentTools, useFeatureStore, undoAgentTurns, type FeatureStore } from '#/runtime/index';
import { useSystemPrompt } from '#/runtime/hooks';

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function scriptedRequester(next: (rest: GenerateRest) => LlmOutcome | Promise<LlmOutcome>): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest, _control) => next(rest),
  };
  return self;
}

function echoRequester(): LoopLlmRequester {
  return scriptedRequester((rest) => {
    const messages = rest.content?.messages ?? [];
    const last = messages.at(-1);
    const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
    return textOutcome(`echo:${text}`);
  });
}

function mergingRequester(): LoopLlmRequester {
  const make = (filled: Record<string, unknown>): LoopLlmRequester => ({
    with: (part) => make({ ...filled, ...(part as Record<string, unknown>) }),
    request: (rest) => ({ ...filled, ...rest }) as unknown as LlmRequest,
    generate: async () => textOutcome('ok'),
  });
  return make({});
}

function user(text: string, meta: UserMeta = {}) {
  return createUserEntry(createUserMessage(text), { source: 'input', ...meta });
}

function userTexts(messages: readonly HistoryMessage[]): string[] {
  return messages.filter((entry) => entry.message.role === 'user').map((entry) => extractText(entry.message));
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

interface ProbeState {
  readonly values: readonly string[];
}

type ProbeEvent = { readonly type: 'probe.set'; readonly value: string; readonly turnId?: number };

const probeProjection: Projection<ProbeState, ProbeEvent> = {
  initial: () => ({ values: [] }),
  reduce: (state, entry) =>
    entry.event.type === 'probe.set' ? { values: [...state.values, entry.event.value] } : state,
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('harness runtime', () => {
  it('runs a turn through ensureAgent caps', async () => {
    const harness = createHarness({ space: memoryHarnessSpace() });
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main', { systemPrompt: 'HOST' });
    setRequester(harness, 's1', 'main', echoRequester());
    const outcome = await agent.loop.runTurn(user('hello'));
    expect(outcome.type).toBe('done');
    await agent.flush();
    const texts = agent.view
      .getState()
      .messages.filter((entry) => entry.message.role === 'assistant')
      .map((entry) => extractText(entry.message));
    expect(texts).toEqual(['echo:hello']);
    await harness.close();
  });

  it('wires feature tools, system prompt, store and events', async () => {
    let executed = 0;
    let store: FeatureStore<ProbeState, ProbeEvent> | undefined;
    const probe = createFeature('probe', {
      agent: () => {
        useAgentTools({
          name: 'probe_tool',
          description: 'probe',
          parameters: { type: 'object' },
          execute: async () => {
            executed += 1;
            return { content: [{ type: 'text', text: 'tool-output' }] };
          },
        });
        useSystemPrompt({ id: 'probe', text: 'PROBE' });
        store = useFeatureStore('agent', 'probe', probeProjection);
      },
    });
    const harness = createHarness({ space: memoryHarnessSpace() });
    await harness.app.features.add(probe);
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main', { systemPrompt: 'HOST' });
    setRequester(
      harness,
      's1',
      'main',
      scriptedRequester((rest) => {
        const hasTool = (rest.content?.messages ?? []).some((message) => message.role === 'tool');
        if (!hasTool) {
          return textOutcome('calling', [{ type: 'function', id: 'c1', name: 'probe_tool', arguments: '{}' }]);
        }
        return textOutcome('done');
      }),
    );
    await tick();
    expect(agent.loop.state.profile.systemPrompt).toBe('HOST\n\nPROBE');
    expect(agent.loop.state.profile.tools?.map((tool) => tool.name)).toEqual(['probe_tool']);
    const outcome = await agent.loop.runTurn(user('go'));
    expect(outcome.type).toBe('done');
    expect(executed).toBe(1);

    const seen: string[] = [];
    harness.app.on('probe.set', (event) => seen.push((event as ProbeEvent).value));
    if (store === undefined) throw new Error('probe store was not captured');
    await store.dispatch([{ type: 'probe.set', value: 'a' }]);
    expect(seen).toEqual(['a']);
    expect(store.state.value.values).toEqual(['a']);
    await harness.close();
  });

  it('freezes the system prompt after first settle', async () => {
    const early = createFeature('early', {
      agent: () => {
        useSystemPrompt({ id: 'early', text: 'EARLY' });
      },
    });
    const late = createFeature('late', {
      agent: () => {
        useSystemPrompt({ id: 'late', text: 'LATE' });
      },
    });
    const harness = createHarness({ space: memoryHarnessSpace() });
    await harness.app.features.add(early);
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main', { systemPrompt: 'HOST' });
    await tick();
    expect(agent.loop.state.profile.systemPrompt).toBe('HOST\n\nEARLY');
    await harness.app.features.add(late);
    await tick();
    expect(agent.loop.state.profile.systemPrompt).toBe('HOST\n\nEARLY');
    await harness.close();
  });

  it('restores feature stores across reopen and rewinds them with undo', async () => {
    let store: FeatureStore<ProbeState, ProbeEvent> | undefined;
    let sessionStore: FeatureStore<ProbeState, ProbeEvent> | undefined;
    const probe = createFeature('probe', {
      agent: () => {
        store = useFeatureStore('agent', 'probe', probeProjection);
      },
      session: () => {
        sessionStore = useFeatureStore('session', 'probe-session', probeProjection);
      },
    });
    const space = memoryHarnessSpace();
    const harness = createHarness({ space });
    await harness.app.features.add(probe);
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main');
    setRequester(harness, 's1', 'main', echoRequester());

    await agent.loop.runTurn(user('one'));
    await agent.flush();
    if (store === undefined || sessionStore === undefined) throw new Error('stores not captured');
    await store.dispatch([{ type: 'probe.set', value: 'turn-1' }]);
    await sessionStore.dispatch([{ type: 'probe.set', value: 'session-1' }]);
    await agent.loop.runTurn(user('two'));
    await agent.flush();
    await store.dispatch([{ type: 'probe.set', value: 'turn-2' }]);
    expect(store.state.value.values).toEqual(['turn-1', 'turn-2']);

    await harness.app.close('s1');
    const resumed = await harness.app.create({ sessionId: 's1' });
    const agent2 = await harness.ensureAgent(resumed, 'main');
    setRequester(harness, 's1', 'main', echoRequester());
    if (store === undefined) throw new Error('store not captured after resume');
    expect(store.state.value.values).toEqual(['turn-1', 'turn-2']);
    expect(userTexts(agent2.view.getState().messages)).toEqual(['one', 'two']);

    await undoAgentTurns(harness.app, resumed, 'main', 1);
    expect(store.state.value.values).toEqual(['turn-1']);
    expect(sessionStore?.state.value.values).toEqual(['session-1']);
    expect(userTexts(agent2.view.getState().messages)).toEqual(['one']);
    await harness.close();
  });

  it('layers feature policy lists onto the base requester', async () => {
    const harness = createHarness({ space: memoryHarnessSpace() });
    const session = await harness.app.create({ sessionId: 's1' });
    await harness.ensureAgent(session, 'main');
    const runtime = harnessInternals(harness.app).agents.get(session)?.get('main');
    if (runtime === undefined) throw new Error('runtime missing');
    expect(() => agentCaps(runtime).requester()).toThrow(/no requester/);
    const resolver = { id: 'probe', resolve: async (messages: readonly never[]) => messages };
    const recovery = { id: 'probe', propose: () => undefined };
    runtime.resolvers.push(resolver as never);
    runtime.recoveries.push(recovery as never);
    runtime.requester = mergingRequester();
    const layered = agentCaps(runtime).requester();
    const request = layered.request({ content: { messages: [] } }) as unknown as {
      policy: { resolvers: () => unknown[]; recoveries: () => unknown[]; retryables: () => unknown[] };
    };
    expect(request.policy.resolvers()).toEqual([resolver]);
    expect(request.policy.recoveries()).toEqual([recovery]);
    expect(request.policy.retryables()).toEqual([]);
    await harness.close();
  });
});
