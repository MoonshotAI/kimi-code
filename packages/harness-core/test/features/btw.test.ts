import { describe, expect, it } from 'vitest';

import { createFeature, type Feature, createApp, type App, useAgentTools } from '#/app/index';
import { createUserEntry, type HistoryMessage } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '#/kernel/index';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
  type ToolCall,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID, memorySessionSpace, type Agent, type Session, type SessionSpace } from '@moonshot-ai/agent-core/session/index';

import {
  BTW_TOOL_DENIED_MESSAGE,
  BtwRef,
  createBtw,
  SIDE_QUESTION_SYSTEM_REMINDER,
  type BtwCreatedEvent,
  type BtwEvent,
  type BtwFace,
} from '#/features/btw/index';

let callSeq = 0;

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function toolCallOutcome(name: string): LlmOutcome {
  return textOutcome('', [
    { type: 'function', id: `call-${(callSeq += 1)}`, name, arguments: '{}' },
  ]);
}

function createMockRequester(): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest) => {
      const messages = rest.content?.messages ?? [];
      const last = messages.at(-1);
      if (last !== undefined && last.role === 'tool') {
        const text = extractText(last);
        if (text.includes('disabled')) return toolCallOutcome('Read');
        return textOutcome(`done:${text}`);
      }
      const question = messages.findLast(
        (message) => message.role === 'user' && !extractText(message).includes('<system-reminder>'),
      );
      const text = question === undefined ? '' : extractText(question);
      if (text === 'run bash') return toolCallOutcome('Bash');
      return textOutcome(`echo:${text}`);
    },
  };
  return self;
}

function bindTestTools(executed: string[]): Feature<void> {
  return createFeature('test-tools', {
    agent() {
      useAgentTools(
        {
          name: 'Read',
          description: 'Read a file',
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            executed.push('Read');
            return { content: [{ type: 'text', text: 'file contents' }] };
          },
        },
        {
          name: 'Bash',
          description: 'Run a shell command',
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            executed.push('Bash');
            return { content: [{ type: 'text', text: 'bash output' }] };
          },
        },
      );
    },
  });
}

function captureBtw(): { feature: Feature<void>; face(): BtwFace } {
  let exposed: Readonly<ShallowRef<BtwFace | undefined>> | undefined;
  const feature = createFeature('btw-probe', {
    session: () => {
      exposed = useInject(BtwRef);
    },
  });
  return {
    feature,
    face: () => {
      const value = exposed?.value;
      if (value === undefined) throw new Error('btw facade was not captured');
      return value;
    },
  };
}

function setRequester(
  harness: App,
  sessionId: string,
  agentId: string,
  requester: LoopLlmRequester,
): void {
  const session = harness.sessions.get(sessionId);
  const runtime =
    session !== undefined
      ? session.agentRuntime(agentId)
      : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function historyOf(agent: Agent): readonly HistoryMessage[] {
  return agent.view.getState().messages;
}

function userTexts(agent: Agent): string[] {
  return historyOf(agent)
    .filter((entry) => entry.message.role === 'user')
    .map((entry) => extractText(entry.message));
}

function toolTexts(agent: Agent): string[] {
  return historyOf(agent)
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function assistantTexts(agent: Agent): string[] {
  return historyOf(agent)
    .filter((entry) => entry.message.role === 'assistant')
    .map((entry) => extractText(entry.message));
}

interface BtwTestEnv {
  readonly harness: App;
  readonly session: Session;
  readonly btwFeature: Feature<void, { session: BtwEvent }>;
  readonly executed: string[];
  main(): Agent;
  face(): BtwFace;
}

async function startBtwTest(opts?: {
  readonly space?: SessionSpace;
}): Promise<BtwTestEnv> {
  const btwFeature = createBtw();
  const probe = captureBtw();
  const executed: string[] = [];
  const harness = createApp({ space: opts?.space ?? memorySessionSpace() });
  harness.features.add(btwFeature);
  harness.features.add(probe.feature);
  harness.features.add(bindTestTools(executed));
  const session = await harness.open('sess');
  const { agent: main } = await session.ensureAgent(MAIN_AGENT_ID, { systemPrompt: 'main-host' });
  setRequester(harness, 'sess', MAIN_AGENT_ID, createMockRequester());
  return { harness, session, btwFeature, executed, main: () => main, face: probe.face };
}

describe('btw feature', () => {
  it('forks the source agent with full history, injects the side-question reminder, and fires btw.created', async () => {
    const env = await startBtwTest();
    const createdEvents: BtwCreatedEvent[] = [];
    env.harness.on(env.btwFeature, 'btw.created', (event) => {
      createdEvents.push(event);
    });
    await env.main().loop.runTurn(user('hello'));
    await env.main().flush();

    const child = await env.face().create();
    expect(child.id).toMatch(/^btw-/);
    expect(env.face().list()).toEqual([child.id]);
    expect(env.face().isBtw(child.id)).toBe(true);
    expect(env.face().isBtw(MAIN_AGENT_ID)).toBe(false);
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]).toMatchObject({ agentId: child.id, sourceId: MAIN_AGENT_ID });

    await child.flush();
    expect(userTexts(child)).toContain('hello');
    expect(assistantTexts(child)).toContain('echo:hello');
    const reminders = child.loop.state.inbox.remind.map((entry) => extractText(entry.message));
    expect(reminders).toContain(
      `<system-reminder>\n${SIDE_QUESTION_SYSTEM_REMINDER}\n</system-reminder>`,
    );

    await env.harness.close();
  });

  it('denies non-readonly tools on the btw agent while allowing whitelisted ones, and leaves other agents untouched', async () => {
    const env = await startBtwTest();
    const child = await env.face().create();
    setRequester(env.harness, 'sess', child.id, createMockRequester());

    await child.loop.runTurn(user('run bash'));
    await child.flush();

    expect(env.executed).toEqual(['Read']);
    expect(toolTexts(child)).toEqual([BTW_TOOL_DENIED_MESSAGE, 'file contents']);
    expect(userTexts(child)).toContain(
      `<system-reminder>\n${SIDE_QUESTION_SYSTEM_REMINDER}\n</system-reminder>`,
    );
    expect(assistantTexts(child)).toContain('done:file contents');

    const openChild = await env.face().create({ readonlyTools: ['Read', 'Bash'] });
    setRequester(env.harness, 'sess', openChild.id, createMockRequester());

    env.executed.length = 0;
    await openChild.loop.runTurn(user('run bash'));
    await openChild.flush();

    expect(env.executed).toEqual(['Bash']);
    expect(toolTexts(openChild)).toEqual(['bash output']);

    env.executed.length = 0;
    await env.main().loop.runTurn(user('run bash'));
    await env.main().flush();

    expect(env.executed).toEqual(['Bash']);
    expect(toolTexts(env.main())).toEqual(['bash output']);

    await env.harness.close();
  });

  it('rejects with a clear error when the source agent does not exist', async () => {
    const missingMain = await startBtwTest();
    await missingMain.session.closeAgent(MAIN_AGENT_ID);
    await expect(missingMain.face().create()).rejects.toThrow(
      "Cannot start a side question: source agent 'main' does not exist or is not running in this session.",
    );
    await missingMain.harness.close();

    const missingSource = await startBtwTest();
    await expect(missingSource.face().create({ sourceAgentId: 'ghost' })).rejects.toThrow(
      "Cannot start a side question: source agent 'ghost' does not exist or is not running in this session.",
    );
    await missingSource.harness.close();
  });

  it('recovers membership and the readonly guard from the persisted roster after remount', async () => {
    const space = memorySessionSpace();
    const first = await startBtwTest({ space });
    const created = await first.face().create();
    await first.harness.close();

    const second = await startBtwTest({ space });
    expect(second.face().isBtw(created.id)).toBe(true);
    expect(second.face().list()).toEqual([created.id]);

    const { agent: child } = await second.session.ensureAgent(created.id);
    setRequester(second.harness, 'sess', created.id, createMockRequester());
    await child.loop.runTurn(user('run bash'));
    await child.flush();
    expect(second.executed).toEqual(['Read']);
    expect(toolTexts(child)[0]).toBe(BTW_TOOL_DENIED_MESSAGE);

    await second.harness.close();
  });
});
