import { afterEach, describe, expect, it } from 'vitest';

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
  useAgentTools,
  type AgentHandle,
  type FeatureSpec,
  type AgentLlmRequester,
  type Message,
  type SessionStores,
  type ToolDescription,
  type ToolMeta,
} from '@moonshot-ai/agent-core';

import {
  createNotify,
  NOTIFY_REMIND_KEY,
  NOTIFY_USER_DELIVERED_OUTPUT,
  NOTIFY_USER_EMPTY_MESSAGE,
  NOTIFY_USER_GUIDANCE,
  NOTIFY_USER_SUPPRESSED_OUTPUT,
  NOTIFY_USER_TOOL_NAME,
  type NotifyShownEvent,
} from '#/features/notify/index';

import { fakeRequester, testModel, textOutcome } from '../fake-llm';

interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

interface ScriptOut {
  readonly text?: string;
  readonly toolCall?: { name: string; arguments: string };
}

type LlmScript = (call: LlmCall) => ScriptOut;

function createMockRequester(script: LlmScript): { requester: AgentLlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    calls,
    requester: fakeRequester((rest, onEvent) => {
      const call: LlmCall = {
        systemPrompt: rest.profile?.systemPrompt,
        messages: rest.content?.messages ?? [],
        tools: rest.profile?.tools ?? [],
      };
      calls.push(call);
      const out = script(call);
      onEvent?.({
        type: 'llm.streaming.usage',
        usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
      });
      return textOutcome(
        out.text ?? '',
        out.toolCall === undefined
          ? []
          : [{ type: 'function', id: `call-${calls.length}`, name: out.toolCall.name, arguments: out.toolCall.arguments }],
      );
    }),
  };
}

const singleCallScript: LlmScript = (call) => {
  const last = call.messages.at(-1);
  if (last !== undefined && last.role === 'tool') return { text: 'done' };
  const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
  if (text.startsWith('CALL:')) {
    return { toolCall: JSON.parse(text.slice('CALL:'.length)) as { name: string; arguments: string } };
  }
  return { text: `echo:${text}` };
};

function silentCallsScript(calls: number): LlmScript {
  let remaining = calls;
  return () => {
    if (remaining > 0) {
      remaining -= 1;
      return { toolCall: { name: 'Read', arguments: '{}' } };
    }
    return { text: 'done' };
  };
}

function bindTestLlm(requester: AgentLlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setModel(testModel);
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

async function startApp(notify: FeatureSpec, script: LlmScript = singleCallScript) {
  const env = await testStores();
  const { requester, calls } = createMockRequester(script);
  const app = createHarness({ features: [notify, bindTestTools(), bindTestLlm(requester)] });
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

async function runTurn(agent: AgentHandle, text: string): Promise<void> {
  const done = nextTurnDone(agent);
  agent.submit(createUserMessage(text));
  await done;
}

function notifyToolCall(args: unknown): string {
  return `CALL:${JSON.stringify({ name: NOTIFY_USER_TOOL_NAME, arguments: JSON.stringify(args) })}`;
}

function nudgeReminders(stores: SessionStores, agentId: string): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.meta?.source === 'reminder' && entry.meta?.key === NOTIFY_REMIND_KEY)
    .map((entry) => extractText(entry.message));
}

function toolResults(stores: SessionStores, agentId: string): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolResultIsErrors(stores: SessionStores, agentId: string): boolean[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => (entry.meta as ToolMeta | undefined)?.isError === true);
}

afterEach(() => {
  delete process.env['KIMI_CODE_EXPERIMENTAL_NOTIFY_USER'];
  delete process.env['KIMI_CODE_EXPERIMENTAL_FLAG'];
});

describe('notify feature', () => {
  it('registers the NotifyUser tool and guidance only when available', async () => {
    const off = await startApp(createNotify({ available: () => false }));
    await runTurn(off.main, 'hello');
    expect(off.calls[0]!.tools.map((tool) => tool.name)).not.toContain(NOTIFY_USER_TOOL_NAME);
    expect(off.calls[0]!.systemPrompt ?? '').not.toContain(NOTIFY_USER_GUIDANCE);
    await off.app.disposeAsync();
    await off.env.stores.dispose();

    const on = await startApp(createNotify({ available: () => true }));
    await runTurn(on.main, 'hello');
    const tool = on.calls[0]!.tools.find((candidate) => candidate.name === NOTIFY_USER_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool?.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: { message: { type: 'string', minLength: 1 } },
    });
    expect(tool?.description).toContain('When to use');
    expect(on.calls[0]!.systemPrompt ?? '').toContain(NOTIFY_USER_GUIDANCE);
    await on.app.disposeAsync();
    await on.env.stores.dispose();
  });

  it('enables the tool by default through the experimental env flags', async () => {
    process.env['KIMI_CODE_EXPERIMENTAL_NOTIFY_USER'] = 'true';
    const flagged = await startApp(createNotify());
    await runTurn(flagged.main, 'hello');
    expect(flagged.calls[0]!.tools.map((tool) => tool.name)).toContain(NOTIFY_USER_TOOL_NAME);
    await flagged.app.disposeAsync();
    await flagged.env.stores.dispose();

    delete process.env['KIMI_CODE_EXPERIMENTAL_NOTIFY_USER'];
    process.env['KIMI_CODE_EXPERIMENTAL_FLAG'] = '1';
    const master = await startApp(createNotify());
    await runTurn(master.main, 'hello');
    expect(master.calls[0]!.tools.map((tool) => tool.name)).toContain(NOTIFY_USER_TOOL_NAME);
    await master.app.disposeAsync();
    await master.env.stores.dispose();
  });

  it('acknowledges a delivered update and emits notify.shown', async () => {
    const notify = createNotify({ available: () => true });
    const { app, env, main, session } = await startApp(notify);
    const shown: NotifyShownEvent[] = [];
    session.on(notify, 'notify.shown', (event) => {
      shown.push(event);
    });
    await runTurn(main, notifyToolCall({ message: 'Found the root cause.' }));
    await env.stores.flush();

    expect(toolResults(env.stores, MAIN_AGENT_ID)).toEqual([NOTIFY_USER_DELIVERED_OUTPUT]);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      message: 'Found the root cause.',
      sessionId: 'sess',
      agentId: MAIN_AGENT_ID,
    });

    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('acknowledges without displaying when availability drops mid-session', async () => {
    let enabled = true;
    const notify = createNotify({ available: () => enabled });
    const { app, env, main, session } = await startApp(notify);
    const shown: NotifyShownEvent[] = [];
    session.on(notify, 'notify.shown', (event) => {
      shown.push(event);
    });
    enabled = false;
    await runTurn(main, notifyToolCall({ message: 'Should not appear.' }));
    await env.stores.flush();

    expect(toolResults(env.stores, MAIN_AGENT_ID)).toEqual([NOTIFY_USER_SUPPRESSED_OUTPUT]);
    expect(toolResultIsErrors(env.stores, MAIN_AGENT_ID)).toEqual([false]);
    expect(shown).toHaveLength(0);

    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('rejects an empty message', async () => {
    const notify = createNotify({ available: () => true });
    const { app, env, main, session } = await startApp(notify);
    const shown: NotifyShownEvent[] = [];
    session.on(notify, 'notify.shown', (event) => {
      shown.push(event);
    });
    await runTurn(main, notifyToolCall({ message: '   \n' }));
    await env.stores.flush();

    expect(toolResults(env.stores, MAIN_AGENT_ID)).toEqual([NOTIFY_USER_EMPTY_MESSAGE]);
    expect(toolResultIsErrors(env.stores, MAIN_AGENT_ID)).toEqual([true]);
    expect(shown).toHaveLength(0);

    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('nudges after 8 silent tool calls and repeats every 8', async () => {
    const { app, env, main } = await startApp(
      createNotify({ available: () => true }),
      silentCallsScript(18),
    );
    await runTurn(main, 'work');
    await env.stores.flush();

    const reminders = nudgeReminders(env.stores, MAIN_AGENT_ID);
    expect(reminders).toHaveLength(2);
    expect(reminders[0]).toContain('8 tool calls');
    expect(reminders[1]).toContain('17 tool calls');

    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('hints once when a mid-turn text reply appears', async () => {
    let step = 0;
    const script: LlmScript = () => {
      step += 1;
      if (step === 1) return { text: 'searching now', toolCall: { name: 'Read', arguments: '{}' } };
      if (step === 2) return { toolCall: { name: 'Read', arguments: '{}' } };
      return { text: 'done' };
    };
    const { app, env, main } = await startApp(createNotify({ available: () => true }), script);
    await runTurn(main, 'work');
    await env.stores.flush();

    const reminders = nudgeReminders(env.stores, MAIN_AGENT_ID);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain('mid-turn text reply');

    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('does not inject again after a remount when the streak stays below the threshold', async () => {
    let step = 0;
    const script: LlmScript = () => {
      step += 1;
      if (step <= 9) return { toolCall: { name: 'Read', arguments: '{}' } };
      if (step === 10) return { text: 'done' };
      if (step <= 13) return { toolCall: { name: 'Read', arguments: '{}' } };
      return { text: 'done' };
    };
    const { app, env, session } = await startApp(createNotify({ available: () => true }), script);
    let main = session.get(MAIN_AGENT_ID) as AgentHandle;

    await runTurn(main, 'work');
    await env.stores.flush();
    expect(nudgeReminders(env.stores, MAIN_AGENT_ID)).toHaveLength(1);

    await session.close(MAIN_AGENT_ID);
    main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
    await runTurn(main, 'more');
    await env.stores.flush();

    expect(nudgeReminders(env.stores, MAIN_AGENT_ID)).toHaveLength(1);

    await app.disposeAsync();
    await env.stores.dispose();
  });
});
