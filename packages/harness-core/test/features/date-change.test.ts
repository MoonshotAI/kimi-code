import { describe, expect, it } from 'vitest';

import {
  createFeature,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  mountApp,
  openBlobs,
  openSessionStores,
  Trees,
  UNKNOWN_CAPABILITY,
  useAgent,
  useAgentTools,
  type AgentHandle,
  type FeatureSpec,
  type LlmModel,
  type LlmRequester,
  type Message,
  type SessionStores,
  type ToolDescription,
} from '@moonshot-ai/agent-core';

import {
  createDateChange,
  DATE_CHANGE_REMIND_KEY,
  dateChangeReminder,
  initialDateReminder,
} from '#/features/dateChange/index';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type LlmScript = (call: LlmCall) => { text: string } | { toolCall: { name: string; arguments: string } };

function createMockRequester(script: LlmScript): { requester: LlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    calls,
    requester: {
      generate: async (_config, content, { onEvent }) => {
        const call: LlmCall = {
          systemPrompt: content.systemPrompt,
          messages: content.messages,
          tools: content.tools ?? [],
        };
        calls.push(call);
        const out = script(call);
        if ('toolCall' in out) {
          onEvent?.({
            type: 'llm.streaming.part',
            part: { type: 'function', id: `call-${calls.length}`, name: out.toolCall.name, arguments: out.toolCall.arguments },
          });
        } else {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: out.text } });
        }
        onEvent?.({
          type: 'llm.streaming.usage',
          usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
        });
        onEvent?.({ type: 'llm.done' });
      },
    },
  };
}

const script: LlmScript = (call) => {
  const last = call.messages.at(-1);
  if (last !== undefined && last.role === 'tool') return { text: 'done' };
  const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
  if (text === 'run') return { toolCall: { name: 'Read', arguments: '{}' } };
  return { text: `echo:${text}` };
};

function bindTestLlm(requester: LlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setConfig({ model });
      agent.setRequester(requester);
    },
  });
}

function bindTestTools(): FeatureSpec {
  return createFeature('test-tools', {
    agent() {
      useAgentTools({
        name: 'Read',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text' as const, text: 'file contents' }] }),
      });
    },
  });
}

async function testStores(): Promise<{ stores: SessionStores }> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return { stores: await openSessionStores(tree, openBlobs(backend.blobs)) };
}

async function startApp(now: () => Date) {
  const env = await testStores();
  const { requester, calls } = createMockRequester(script);
  const app = mountApp({
    features: [createDateChange({ now, timeZone: 'UTC' }), bindTestTools(), bindTestLlm(requester)],
  });
  const session = await app.create({ sessionId: 'sess', stores: env.stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  return { app, env, main, session, calls };
}

function nextTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

function dateReminders(stores: SessionStores, agentId: string): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.meta?.source === 'reminder' && entry.meta?.key === DATE_CHANGE_REMIND_KEY)
    .map((entry) => extractText(entry.message));
}

function reminderText(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`;
}

describe('dateChange feature', () => {
  it('injects the current date once and does not repeat while the date is unchanged, even across an agent remount', async () => {
    const current = new Date('2026-09-27T10:00:00Z');
    const { app, env, session } = await startApp(() => current);
    let main = session.get(MAIN_AGENT_ID) as AgentHandle;

    const first = nextTurnDone(main);
    await main.submit(createUserMessage('run'));
    await first;
    await env.stores.flush();

    expect(dateReminders(env.stores, MAIN_AGENT_ID)).toEqual([
      reminderText(initialDateReminder('2026-09-27')),
    ]);

    const second = nextTurnDone(main);
    await main.submit(createUserMessage('run'));
    await second;
    await env.stores.flush();

    expect(dateReminders(env.stores, MAIN_AGENT_ID)).toHaveLength(1);

    await session.close(MAIN_AGENT_ID);
    main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
    const third = nextTurnDone(main);
    await main.submit(createUserMessage('run'));
    await third;
    await env.stores.flush();

    expect(dateReminders(env.stores, MAIN_AGENT_ID)).toHaveLength(1);

    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('injects the new date exactly once when the date changes across turns', async () => {
    let current = new Date('2026-09-27T10:00:00Z');
    const { app, env, main, calls } = await startApp(() => current);

    const first = nextTurnDone(main);
    await main.submit(createUserMessage('run'));
    await first;
    await env.stores.flush();

    current = new Date('2026-09-28T10:00:00Z');
    const second = nextTurnDone(main);
    await main.submit(createUserMessage('run'));
    await second;
    await env.stores.flush();

    expect(dateReminders(env.stores, MAIN_AGENT_ID)).toEqual([
      reminderText(initialDateReminder('2026-09-27')),
      reminderText(dateChangeReminder('2026-09-28')),
    ]);
    const stepTwo = calls[3]!;
    expect(
      stepTwo.messages.some(
        (message) => message.role === 'user' && extractText(message).includes('2026-09-28'),
      ),
    ).toBe(true);

    const third = nextTurnDone(main);
    await main.submit(createUserMessage('run'));
    await third;
    await env.stores.flush();

    expect(dateReminders(env.stores, MAIN_AGENT_ID)).toHaveLength(2);

    await app.disposeAsync();
    await env.stores.dispose();
  });
});
