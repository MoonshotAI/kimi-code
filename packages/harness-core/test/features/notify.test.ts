import { afterEach, describe, expect, it } from 'vitest';

import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry, type ToolMeta } from '@moonshot-ai/agent-core/history/index';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
  type Message,
  type ToolCall,
  type ToolDescription,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID, type Agent } from '@moonshot-ai/agent-core/session/index';

import {
  createNotify,
  NOTIFY_REMIND_KEY,
  NOTIFY_USER_DELIVERED_OUTPUT,
  NOTIFY_USER_EMPTY_MESSAGE,
  NOTIFY_USER_GUIDANCE,
  NOTIFY_USER_SUPPRESSED_OUTPUT,
  NOTIFY_USER_TOOL_NAME,
  type NotifyEvent,
  type NotifyShownEvent,
} from '#/features/notify/index';
import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  useAgentTools,
  type Harness,
} from '#/runtime/index';

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

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function createMockRequester(script: LlmScript): { requester: LoopLlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest) => {
      const call: LlmCall = {
        systemPrompt: rest.profile?.systemPrompt,
        messages: rest.content?.messages ?? [],
        tools: rest.profile?.tools ?? [],
      };
      calls.push(call);
      const out = script(call);
      return textOutcome(
        out.text ?? '',
        out.toolCall === undefined
          ? []
          : [
              {
                type: 'function',
                id: `call-${calls.length}`,
                name: out.toolCall.name,
                arguments: out.toolCall.arguments,
              },
            ],
      );
    },
  };
  return { requester: self, calls };
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

function bindTestTools(): Feature<void> {
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

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime =
    session !== undefined
      ? harnessInternals(harness.app).agents.get(session)?.get(agentId)
      : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

interface NotifyTestEnv {
  readonly harness: Harness;
  readonly notify: Feature<void, NotifyEvent>;
  readonly main: Agent;
  readonly calls: LlmCall[];
}

async function startApp(
  notify: Feature<void, NotifyEvent>,
  script: LlmScript = singleCallScript,
): Promise<NotifyTestEnv> {
  const { requester, calls } = createMockRequester(script);
  const harness = createHarness({ space: memoryHarnessSpace() });
  await harness.app.features.add(notify);
  await harness.app.features.add(bindTestTools());
  const session = await harness.app.create({ sessionId: 'sess' });
  const main = await harness.ensureAgent(session, MAIN_AGENT_ID, { systemPrompt: 'main-host' });
  setRequester(harness, 'sess', MAIN_AGENT_ID, requester);
  return { harness, notify, main, calls };
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

async function runTurn(agent: Agent, text: string): Promise<void> {
  await agent.loop.runTurn(user(text));
  await agent.flush();
}

function notifyToolCall(args: unknown): string {
  return `CALL:${JSON.stringify({ name: NOTIFY_USER_TOOL_NAME, arguments: JSON.stringify(args) })}`;
}

function nudgeReminders(agent: Agent): string[] {
  return agent.view
    .getState()
    .messages.filter((entry) => entry.meta?.source === 'reminder' && entry.meta?.key === NOTIFY_REMIND_KEY)
    .map((entry) => extractText(entry.message));
}

function toolResults(agent: Agent): string[] {
  return agent.view
    .getState()
    .messages.filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolResultIsErrors(agent: Agent): boolean[] {
  return agent.view
    .getState()
    .messages.filter((entry) => entry.message.role === 'tool')
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
    await off.harness.close();

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
    await on.harness.close();
  });

  it('enables the tool by default through the experimental env flags', async () => {
    process.env['KIMI_CODE_EXPERIMENTAL_NOTIFY_USER'] = 'true';
    const flagged = await startApp(createNotify());
    await runTurn(flagged.main, 'hello');
    expect(flagged.calls[0]!.tools.map((tool) => tool.name)).toContain(NOTIFY_USER_TOOL_NAME);
    await flagged.harness.close();

    delete process.env['KIMI_CODE_EXPERIMENTAL_NOTIFY_USER'];
    process.env['KIMI_CODE_EXPERIMENTAL_FLAG'] = '1';
    const master = await startApp(createNotify());
    await runTurn(master.main, 'hello');
    expect(master.calls[0]!.tools.map((tool) => tool.name)).toContain(NOTIFY_USER_TOOL_NAME);
    await master.harness.close();
  });

  it('acknowledges a delivered update and emits notify.shown', async () => {
    const env = await startApp(createNotify({ available: () => true }));
    const shown: NotifyShownEvent[] = [];
    env.harness.app.on(env.notify, 'notify.shown', (event) => {
      shown.push(event);
    });
    await runTurn(env.main, notifyToolCall({ message: 'Found the root cause.' }));

    expect(toolResults(env.main)).toEqual([NOTIFY_USER_DELIVERED_OUTPUT]);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      message: 'Found the root cause.',
      sessionId: 'sess',
      agentId: MAIN_AGENT_ID,
    });

    await env.harness.close();
  });

  it('acknowledges without displaying when availability drops mid-session', async () => {
    let enabled = true;
    const env = await startApp(createNotify({ available: () => enabled }));
    const shown: NotifyShownEvent[] = [];
    env.harness.app.on(env.notify, 'notify.shown', (event) => {
      shown.push(event);
    });
    enabled = false;
    await runTurn(env.main, notifyToolCall({ message: 'Should not appear.' }));

    expect(toolResults(env.main)).toEqual([NOTIFY_USER_SUPPRESSED_OUTPUT]);
    expect(toolResultIsErrors(env.main)).toEqual([false]);
    expect(shown).toHaveLength(0);

    await env.harness.close();
  });

  it('rejects an empty message', async () => {
    const env = await startApp(createNotify({ available: () => true }));
    const shown: NotifyShownEvent[] = [];
    env.harness.app.on(env.notify, 'notify.shown', (event) => {
      shown.push(event);
    });
    await runTurn(env.main, notifyToolCall({ message: '   \n' }));

    expect(toolResults(env.main)).toEqual([NOTIFY_USER_EMPTY_MESSAGE]);
    expect(toolResultIsErrors(env.main)).toEqual([true]);
    expect(shown).toHaveLength(0);

    await env.harness.close();
  });

  it('nudges after 8 silent tool calls and repeats every 8', async () => {
    const env = await startApp(createNotify({ available: () => true }), silentCallsScript(18));
    await runTurn(env.main, 'work');

    const reminders = nudgeReminders(env.main);
    expect(reminders).toHaveLength(2);
    expect(reminders[0]).toContain('8 tool calls');
    expect(reminders[1]).toContain('17 tool calls');

    await env.harness.close();
  });

  it('hints once when a mid-turn text reply appears', async () => {
    let step = 0;
    const script: LlmScript = () => {
      step += 1;
      if (step === 1) return { text: 'searching now', toolCall: { name: 'Read', arguments: '{}' } };
      if (step === 2) return { toolCall: { name: 'Read', arguments: '{}' } };
      return { text: 'done' };
    };
    const env = await startApp(createNotify({ available: () => true }), script);
    await runTurn(env.main, 'work');

    const reminders = nudgeReminders(env.main);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain('mid-turn text reply');

    await env.harness.close();
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
    const env = await startApp(createNotify({ available: () => true }), script);
    let main = env.main;

    await runTurn(main, 'work');
    expect(nudgeReminders(main)).toHaveLength(1);

    const session = env.harness.app.sessions.get('sess');
    if (session === undefined) throw new Error("session 'sess' is not live");
    await session.close(MAIN_AGENT_ID);
    main = await env.harness.ensureAgent(session, MAIN_AGENT_ID, { systemPrompt: 'main-host' });
    const { requester } = createMockRequester(script);
    setRequester(env.harness, 'sess', MAIN_AGENT_ID, requester);
    await runTurn(main, 'more');

    expect(nudgeReminders(main)).toHaveLength(1);

    await env.harness.close();
  });
});
