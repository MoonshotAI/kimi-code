import { describe, expect, it } from 'vitest';

import { createFeature, useSystemPrompt, useAgentTools, useFeatureStore } from '#/app/index';
import { createUserEntry, type HistoryMessage, type UserMeta } from '@moonshot-ai/agent-core/history/index';
import { createAssistantMessage, createUserMessage, extractText, type ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import type { Projection } from '@moonshot-ai/agent-core/store/index';

import type { FeatureStore } from '#/app/index';
import { agentCaps } from '#/runtime/agents';
import { createApp, type App } from '#/app/index';
import { memorySessionSpace } from '@moonshot-ai/agent-core/session/index';

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

function setRequester(harness: App, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.sessions.get(sessionId);
  const runtime = session !== undefined ? session.agentRuntime(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

interface ProbeState {
  readonly values: readonly string[];
}

type ProbeEvent = { readonly type: 'probe.set'; readonly value: string };

const probeProjection: Projection<ProbeState, ProbeEvent> = {
  initial: () => ({ values: [] }),
  reduce: (state, entry) =>
    entry.event.type === 'probe.set' ? { values: [...state.values, entry.event.value] } : state,
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('app agent runtime', () => {
  it('runs a turn through ensureAgent caps', async () => {
    const harness = createApp({ space: memorySessionSpace() });
    const session = await harness.open('s1');
    const { agent } = await session.ensureAgent('main', { systemPrompt: 'HOST' });
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
    const harness = createApp({ space: memorySessionSpace() });
    harness.features.add(probe);
    const session = await harness.open('s1');
    const { agent } = await session.ensureAgent('main', { systemPrompt: 'HOST' });
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
    harness.on('probe.set', (event) => seen.push((event as ProbeEvent).value));
    if (store === undefined) throw new Error('probe store was not captured');
    await store.dispatch([{ type: 'probe.set', value: 'a' }]);
    expect(seen).toEqual(['a']);
    expect(store.state.value.values).toEqual(['a']);
    await harness.close();
  });

  it('freezes the system prompt after the create-time settle', async () => {
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
    const harness = createApp({ space: memorySessionSpace() });
    harness.features.add(early);
    const session = await harness.open('s1');
    const { agent } = await session.ensureAgent('main', { systemPrompt: 'HOST' });
    await tick();
    expect(agent.loop.state.profile.systemPrompt).toBe('HOST\n\nEARLY');
    harness.features.add(late);
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
    const space = memorySessionSpace();
    const harness = createApp({ space });
    harness.features.add(probe);
    const session = await harness.open('s1');
    const { agent } = await session.ensureAgent('main');
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

    await harness.close('s1');
    const resumed = await harness.open('s1');
    const { agent: agent2 } = await resumed.ensureAgent('main');
    setRequester(harness, 's1', 'main', echoRequester());
    if (store === undefined) throw new Error('store not captured after resume');
    expect(store.state.value.values).toEqual(['turn-1', 'turn-2']);
    expect(userTexts(agent2.view.getState().messages)).toEqual(['one', 'two']);

    await resumed.undo('main', 1);
    expect(store.state.value.values).toEqual(['turn-1']);
    expect(sessionStore?.state.value.values).toEqual(['session-1']);
    expect(userTexts(agent2.view.getState().messages)).toEqual(['one']);
    await harness.close();
  });

  it('exposes the base requester through agentCaps without layering', async () => {
    const harness = createApp({ space: memorySessionSpace() });
    const session = await harness.open('s1');
    await session.ensureAgent('main');
    const runtime = session.agentRuntime('main');
    if (runtime === undefined) throw new Error('runtime missing');
    expect(() => agentCaps(runtime).requester()).toThrow(/no requester/);
    runtime.requester = mergingRequester();
    expect(agentCaps(runtime).requester()).toBe(runtime.requester);
    await harness.close();
  });
});
