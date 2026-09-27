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
  BTW_TOOL_DENIED_MESSAGE,
  BtwRef,
  createBtw,
  SIDE_QUESTION_SYSTEM_REMINDER,
  type BtwCreatedEvent,
} from '#/features/btw/index';

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
  if (last !== undefined && last.role === 'tool') {
    const text = extractText(last);
    if (text.includes('disabled')) {
      return { toolCall: { name: 'Read', arguments: '{}' } };
    }
    return { text: `done:${text}` };
  }
  const question = call.messages.findLast(
    (message) => message.role === 'user' && !extractText(message).includes('<system-reminder>'),
  );
  const text = question === undefined ? '' : extractText(question);
  if (text === 'run bash') {
    return { toolCall: { name: 'Bash', arguments: '{}' } };
  }
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

function bindTestTools(executed: string[]): FeatureSpec {
  return createFeature('test-tools', {
    agent() {
      useAgentTools(
        {
          name: 'Read',
          description: 'Read a file',
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            executed.push('Read');
            return { content: [{ type: 'text' as const, text: 'file contents' }] };
          },
        },
        {
          name: 'Bash',
          description: 'Run a shell command',
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            executed.push('Bash');
            return { content: [{ type: 'text' as const, text: 'bash output' }] };
          },
        },
      );
    },
  });
}

async function testStores(): Promise<{ stores: SessionStores }> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return { stores: await openSessionStores(tree, openBlobs(backend.blobs)) };
}

async function startApp(opts?: { sourceAgentId?: string }) {
  const env = await testStores();
  const { requester } = createMockRequester(script);
  const executed: string[] = [];
  const btw = createBtw({ sourceAgentId: opts?.sourceAgentId });
  const app = mountApp({ features: [btw, bindTestTools(executed), bindTestLlm(requester)] });
  const session = await app.create({ sessionId: 'sess', stores: env.stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  const face = session.resolve(BtwRef);
  return { app, env, main, session, btw, face, executed };
}

function nextTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

function userTexts(stores: SessionStores, agentId: string): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'user')
    .map((entry) => extractText(entry.message));
}

function toolTexts(stores: SessionStores, agentId: string): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function assistantTexts(stores: SessionStores, agentId: string): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'assistant')
    .map((entry) => extractText(entry.message));
}

describe('btw feature', () => {
  it('forks the source agent with full history, injects the side-question reminder, and fires btw.created', async () => {
    const { app, env, main, session, btw, face } = await startApp();
    const createdEvents: BtwCreatedEvent[] = [];
    session.on(btw, 'btw.created', (event) => {
      createdEvents.push(event);
    });
    const done = nextTurnDone(main);
    await main.submit(createUserMessage('hello'));
    await done;
    await env.stores.flush();

    const { agentId } = await face.ask();
    expect(agentId).toMatch(/^btw-/);
    expect(face.list()).toEqual([agentId]);
    expect(face.isBtw(agentId)).toBe(true);
    expect(face.isBtw(MAIN_AGENT_ID)).toBe(false);
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]).toMatchObject({ agentId, sourceId: MAIN_AGENT_ID });

    await env.stores.flush();
    expect(userTexts(env.stores, agentId)).toContain('hello');
    expect(assistantTexts(env.stores, agentId)).toContain('echo:hello');

    const child = session.get(agentId);
    const reminders = child?.snapshot.value?.context.reminders ?? [];
    expect(reminders.map((entry) => extractText(entry.message))).toContain(
      `<system-reminder>\n${SIDE_QUESTION_SYSTEM_REMINDER}\n</system-reminder>`,
    );

    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('denies non-readonly tools on the btw agent while allowing whitelisted ones, and leaves other agents untouched', async () => {
    const { app, env, main, session, face, executed } = await startApp();
    const { agentId } = await face.ask();
    const child = session.get(agentId) as AgentHandle;

    const first = nextTurnDone(child);
    await child.submit(createUserMessage('run bash'));
    await first;
    await env.stores.flush();

    expect(executed).toEqual(['Read']);
    const results = toolTexts(env.stores, agentId);
    expect(results).toHaveLength(3);
    expect(results[0]).toBe(BTW_TOOL_DENIED_MESSAGE);
    expect(results[1]).toBe(BTW_TOOL_DENIED_MESSAGE);
    expect(results[2]).toBe('file contents');
    expect(userTexts(env.stores, agentId)).toContain(
      `<system-reminder>\n${SIDE_QUESTION_SYSTEM_REMINDER}\n</system-reminder>`,
    );
    expect(assistantTexts(env.stores, agentId)).toContain('done:file contents');

    executed.length = 0;
    const second = nextTurnDone(main);
    await main.submit(createUserMessage('run bash'));
    await second;
    await env.stores.flush();

    expect(executed).toEqual(['Bash']);
    expect(toolTexts(env.stores, MAIN_AGENT_ID)).toEqual(['bash output']);

    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('rejects with a clear error when the source agent does not exist', async () => {
    const missingMain = await startApp();
    await missingMain.session.close(MAIN_AGENT_ID);
    await expect(missingMain.face.ask()).rejects.toThrow(
      "Cannot start a side question: source agent 'main' does not exist or is not running in this session.",
    );
    await missingMain.app.disposeAsync();
    await missingMain.env.stores.dispose();

    const missingSource = await startApp({ sourceAgentId: 'ghost' });
    await expect(missingSource.face.ask()).rejects.toThrow(
      "Cannot start a side question: source agent 'ghost' does not exist or is not running in this session.",
    );
    await missingSource.app.disposeAsync();
    await missingSource.env.stores.dispose();
  });
});
