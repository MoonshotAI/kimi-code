import { describe, expect, it, vi } from 'vitest';
import { createActor, waitFor } from '#/xstate2';

const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  originalWarn(...args);
  originalWarn(new Error('warn-trace').stack?.split('\n').slice(1, 16).join('\n'));
};

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
  type AssistantMessage,
  type StreamedMessagePart,
  type ToolCall,
} from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { createLlmMachine, type LlmEvent } from '#/llm/requester/machine';
import type { LlmRequester, LlmRequestEvent } from '#/llm/requester/requester';
import type { LlmRetryOptions } from '#/llm/requester/retry';
import { emptyUsage, type TokenUsage } from '#/llm/usage';
import { connectPlugins } from '#/plugin';
import { createTimingPlugin } from '#/timing/plugin';
import { createAgentMachine, type AgentEmitted } from '#/agent/machine';
import { estimateMessageTokens, estimateTextTokens } from '#/agent/context-usage';
import {
  createTurnMachine,
  createUserEntry,
  toInputMessages,
  type AssistantEntry,
  type HistoryMessage,
} from '#/agent/turn';
import { MaxStepsExceededError } from '#/agent/errors';
import { waitForTool } from '#/tool/wait-for';
import { defineTool, type ToolDefinition } from '#/tool/tool';
import type { ToolResult } from '#/tool/executor';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

function toolCall(id: string, name: string, args: string = '{}'): ToolCall {
  return { type: 'function', id, name, arguments: args };
}

function streamMessage(
  message: AssistantMessage,
  onEvent: ((event: LlmRequestEvent) => void) | undefined,
): void {
  for (const part of [...message.content, ...message.toolCalls]) {
    onEvent?.({ type: 'llm.delta', part });
  }
  onEvent?.({ type: 'llm.message-id', messageId: 'msg-stub' });
  onEvent?.({
    type: 'llm.finish',
    finish: { finishReason: 'completed', rawFinishReason: 'stop' },
  });
  onEvent?.({ type: 'llm.done' });
}

function createStubRequester(responses: readonly AssistantMessage[]): LlmRequester {
  let call = 0;
  return {
    generate: (_config, _content, { onEvent }) => {
      const message = responses[Math.min(call, responses.length - 1)] as AssistantMessage;
      call += 1;
      streamMessage(message, onEvent);
      return Promise.resolve();
    },
  };
}

function createTestAgentMachine(
  tools: readonly ToolDefinition[],
  requester: LlmRequester,
  retry?: LlmRetryOptions,
  abortTimeoutMs?: number,
) {
  return createAgentMachine({
    tools,
    turnActor: createTurnMachine(createLlmMachine({ requester, retry })),
    abortTimeoutMs,
  });
}

function stubTools(
  execute: ToolDefinition['execute'],
  ...names: string[]
): ToolDefinition[] {
  return names.map((name) =>
    defineTool({
      name,
      description: `stub ${name}`,
      parameters: { type: 'object', properties: {} },
      execute,
    }),
  );
}

async function runAgent(
  requester: LlmRequester,
  tools: readonly ToolDefinition[],
  retry?: LlmRetryOptions,
): Promise<HistoryMessage[]> {
  const actor = createActor(createTestAgentMachine(tools, requester, retry), {
    input: { request: { model } },
  });
  actor.start();
  actor.send({ type: 'input.submit', message: createUserMessage('hi') });
  const snapshot = await waitFor(
    actor,
    (s) => s.matches('idle') && s.context.messages.length > 1,
    { timeout: 5000 },
  );
  return snapshot.context.messages;
}

function rolesAndTexts(messages: readonly HistoryMessage[]): string[] {
  return toInputMessages(messages).map((message) => `${message.role}:${extractText(message, '\n')}`);
}

describe('agent machine tool failure', () => {
  it('turns a thrown tool error into a tool message and continues to thinking', async () => {
    const usage: TokenUsage = {
      inputOther: 100,
      output: 5,
      inputCacheRead: 20,
      inputCacheCreation: 10,
    };
    const seenUsedContextTokens: (number | undefined)[] = [];
    let call = 0;
    const requester: LlmRequester = {
      generate: (_config, content, { onEvent }) => {
        seenUsedContextTokens.push(content.usedContextTokens);
        call += 1;
        if (call === 1) {
          onEvent?.({ type: 'llm.usage', usage });
          streamMessage(createAssistantMessage([], [toolCall('call-1', 'fail_tool')]), onEvent);
        } else {
          streamMessage(createAssistantMessage([{ type: 'text', text: 'recovered' }]), onEvent);
        }
        return Promise.resolve();
      },
    };
    const tools = stubTools(() => Promise.reject(new Error('boom')), 'fail_tool');

    const messages = await runAgent(requester, tools);

    expect(rolesAndTexts(messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:boom',
      'assistant:recovered',
    ]);
    const toolMessage = messages[2]?.message;
    expect(toolMessage?.role === 'tool' && toolMessage.toolCallId).toBe('call-1');
    expect(seenUsedContextTokens).toEqual([
      estimateMessageTokens(createUserMessage('hi')) + estimateTextTokens(JSON.stringify(tools)),
      137,
    ]);
  });

  it('continues with the remaining tool calls after a failure', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'fail_tool'), toolCall('call-2', 'ok_tool')]),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    const executed: string[] = [];
    const tools = stubTools(({ toolCall: call }) => {
      executed.push(call.name);
      if (call.name === 'fail_tool') {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
    }, 'fail_tool', 'ok_tool');

    const messages = await runAgent(requester, tools);

    expect(executed).toEqual(['fail_tool', 'ok_tool']);
    expect(rolesAndTexts(messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:boom',
      'tool:ok',
      'assistant:done',
    ]);
  });

  it('stringifies non-Error thrown values', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'fail_tool')]),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    const tools = stubTools(() => Promise.reject('plain failure'), 'fail_tool');

    const messages = await runAgent(requester, tools);

    expect(rolesAndTexts(messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:plain failure',
      'assistant:done',
    ]);
  });

  it('executes multiple tool calls concurrently and keeps toolCall order in messages', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'slow_tool'), toolCall('call-2', 'fast_tool')]),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    const started: string[] = [];
    const resolvers = new Map<string, (result: ToolResult) => void>();
    const tools = stubTools(({ toolCall: call }) => {
      started.push(call.name);
      return new Promise((resolve) => {
        resolvers.set(call.name, resolve);
      });
    }, 'slow_tool', 'fast_tool');

    const messagesPromise = runAgent(requester, tools);
    await vi.waitFor(() => {
      expect(started).toEqual(['slow_tool', 'fast_tool']);
    });

    resolvers.get('fast_tool')?.({ content: [{ type: 'text', text: 'fast' }] });
    resolvers.get('slow_tool')?.({ content: [{ type: 'text', text: 'slow' }] });
    const messages = await messagesPromise;

    expect(rolesAndTexts(messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:slow',
      'tool:fast',
      'assistant:done',
    ]);

    const dupRequester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'slow_tool'), toolCall('call-1', 'fast_tool')]),
      createAssistantMessage([], [toolCall('call-1', 'slow_tool')]),
      createAssistantMessage([], [{ ...toolCall('call-1', 'slow_tool'), rawId: 'call-original' }]),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    const dupStarted: string[] = [];
    const dupResolvers = new Map<string, (result: ToolResult) => void>();
    const dupTools = stubTools(({ toolCall: call }) => {
      dupStarted.push(`${call.id}:${call.name}`);
      return new Promise((resolve) => {
        dupResolvers.set(call.id, resolve);
      });
    }, 'slow_tool', 'fast_tool');

    const dupPromise = runAgent(dupRequester, dupTools);
    await vi.waitFor(() => {
      expect(dupStarted).toEqual(['call-1:slow_tool', 'call-1__2:fast_tool']);
    });
    dupResolvers.get('call-1__2')?.({ content: [{ type: 'text', text: 'fast' }] });
    dupResolvers.get('call-1')?.({ content: [{ type: 'text', text: 'slow' }] });
    await vi.waitFor(() => {
      expect(dupStarted).toEqual(['call-1:slow_tool', 'call-1__2:fast_tool', 'call-1__3:slow_tool']);
    });
    dupResolvers.get('call-1__3')?.({ content: [{ type: 'text', text: 'slow again' }] });
    await vi.waitFor(() => {
      expect(dupStarted).toEqual([
        'call-1:slow_tool',
        'call-1__2:fast_tool',
        'call-1__3:slow_tool',
        'call-1__4:slow_tool',
      ]);
    });
    dupResolvers.get('call-1__4')?.({ content: [{ type: 'text', text: 'slow once more' }] });
    const dupMessages = await dupPromise;

    expect(rolesAndTexts(dupMessages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:slow',
      'tool:fast',
      'assistant:',
      'tool:slow again',
      'assistant:',
      'tool:slow once more',
      'assistant:done',
    ]);
    expect(
      dupMessages
        .filter((entry) => entry.message.role === 'tool')
        .map((entry) => entry.message.toolCallId),
    ).toEqual(['call-1', 'call-1__2', 'call-1__3', 'call-1__4']);
    expect(
      dupMessages
        .filter((entry) => entry.message.role === 'assistant' && entry.message.toolCalls.length > 0)
        .map((entry) => entry.message.toolCalls.map((call) => `${call.id}:${call.rawId ?? ''}`)),
    ).toEqual([
      ['call-1:', 'call-1__2:call-1'],
      ['call-1__3:call-1'],
      ['call-1__4:call-original'],
    ]);

    let attempt = 0;
    const rollbackRequester: LlmRequester = {
      generate: (_config, _content, { onEvent }) => {
        attempt += 1;
        onEvent?.({ type: 'llm.sent' });
        if (attempt === 1) {
          onEvent?.({ type: 'llm.delta', part: toolCall('call-1', 'retry_tool') });
          onEvent?.({
            type: 'llm.failed.remote',
            error: {
              kind: 'status',
              statusCode: 500,
              message: 'server error',
              requestId: null,
              retryAfterMs: null,
              headers: null,
            },
          });
          return Promise.resolve();
        }
        if (attempt === 2) {
          streamMessage(createAssistantMessage([], [toolCall('call-1', 'retry_tool')]), onEvent);
        } else {
          streamMessage(createAssistantMessage([{ type: 'text', text: 'done' }]), onEvent);
        }
        return Promise.resolve();
      },
    };
    const rollbackStarted: string[] = [];
    const rollbackTools = stubTools(({ toolCall: call }) => {
      rollbackStarted.push(call.id);
      return Promise.resolve({ content: [{ type: 'text', text: 'retried' }] });
    }, 'retry_tool');

    const rollbackMessages = await runAgent(rollbackRequester, rollbackTools, {
      maxAttemptsPerStep: 3,
    });

    expect(rollbackStarted).toEqual(['call-1']);
    expect(rolesAndTexts(rollbackMessages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:retried',
      'assistant:done',
    ]);
  });
});

describe('agent machine async tools', () => {
  it('answers a detached tool call with an ack message and delivers the completion as a notification', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'bg_tool')]),
      createAssistantMessage([{ type: 'text', text: 'waiting' }]),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    let resolveBg: ((result: ToolResult) => void) | undefined;
    const tools = stubTools(({ detach }) => {
      detach?.({ text: 'async running: bg_tool' });
      return new Promise((resolve) => {
        resolveBg = resolve;
      });
    }, 'bg_tool');
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toEqual({ idle: 'waiting' });
    });
    expect(actor.getSnapshot().status).toBe('active');
    expect(
      actor.getSnapshot().context.background['call-1']?.ref.getSnapshot().status,
    ).not.toBe('done');

    resolveBg?.({ content: [{ type: 'text', text: 'bg-result' }] });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 6,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:async running: bg_tool',
      'assistant:waiting',
      'user:[async tool completed] bg_tool (tool_call_id=call-1)\nbg-result',
      'assistant:done',
    ]);
    expect(actor.getSnapshot().context.background['call-1']).toBeUndefined();
  });

  it('finishes the turn once sync results and async acks are in, delivering the completion later', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'bg_tool'), toolCall('call-2', 'sync_tool')]),
      createAssistantMessage([{ type: 'text', text: 'turn2' }]),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    const resolvers = new Map<string, (result: ToolResult) => void>();
    const tools = stubTools(({ toolCall: call, detach }) => {
      if (call.name === 'bg_tool') {
        detach?.({ text: 'async running: bg_tool' });
      }
      return new Promise((resolve) => {
        resolvers.set(call.name, resolve);
      });
    }, 'bg_tool', 'sync_tool');
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(() => {
      expect(resolvers.has('sync_tool')).toBe(true);
    });
    resolvers.get('sync_tool')?.({ content: [{ type: 'text', text: 'sync-ok' }] });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toEqual({ idle: 'waiting' });
    });

    resolvers.get('bg_tool')?.({ content: [{ type: 'text', text: 'bg-result' }] });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 7,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:async running: bg_tool',
      'tool:sync-ok',
      'assistant:turn2',
      'user:[async tool completed] bg_tool (tool_call_id=call-1)\nbg-result',
      'assistant:done',
    ]);
  });

  it('lets WaitFor reap a completed background task and delivers the notification in the same batch', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'bg_tool')]),
      createAssistantMessage([], [toolCall('call-2', 'WaitFor', '{"task_id":"call-1","timeout":5}')]),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    let resolveBg: ((result: ToolResult) => void) | undefined;
    const bgTool = defineTool({
      name: 'bg_tool',
      description: 'test background tool',
      parameters: { type: 'object', properties: {} },
      execute: ({ detach }) => {
        detach?.({ text: 'async running: bg_tool' });
        return new Promise((resolve) => {
          resolveBg = resolve;
        });
      },
    });
    const tools = [bgTool, waitForTool];
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.turnTools['call-2']).toBeDefined();
    });
    resolveBg?.({ content: [{ type: 'text', text: 'bg-result' }] });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 7,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:async running: bg_tool',
      'assistant:',
      'tool:completed: call-1',
      'user:[async tool completed] bg_tool (tool_call_id=call-1)\nbg-result',
      'assistant:done',
    ]);
  });

  it('reports running tasks when WaitFor times out and delivers the completion later', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'bg_tool')]),
      createAssistantMessage([], [
        toolCall('call-2', 'WaitFor', '{"task_id":"call-1","timeout":1}'),
      ]),
      createAssistantMessage([{ type: 'text', text: 'ack-timeout' }]),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    let resolveBg: ((result: ToolResult) => void) | undefined;
    const bgTool = defineTool({
      name: 'bg_tool',
      description: 'test background tool',
      parameters: { type: 'object', properties: {} },
      execute: ({ detach }) => {
        detach?.({ text: 'async running: bg_tool' });
        return new Promise((resolve) => {
          resolveBg = resolve;
        });
      },
    });
    const tools = [bgTool, waitForTool];
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(
      () => {
        expect(actor.getSnapshot().value).toEqual({ idle: 'waiting' });
      },
      { timeout: 4000 },
    );
    resolveBg?.({ content: [{ type: 'text', text: 'bg-result' }] });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 8,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:async running: bg_tool',
      'assistant:',
      'tool:running: call-1\ntimedOut after 1000 ms',
      'assistant:ack-timeout',
      'user:[async tool completed] bg_tool (tool_call_id=call-1)\nbg-result',
      'assistant:done',
    ]);
  });

  it('answers WaitFor immediately for an unknown task_id or when nothing is running', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'WaitFor', '{"task_id":"nope","timeout":5}')]),
      createAssistantMessage([], [toolCall('call-2', 'WaitFor', '{"timeout":5}')]),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    const messages = await runAgent(requester, [waitForTool]);

    expect(rolesAndTexts(messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:Task not found: nope',
      'assistant:',
      'tool:no async tool calls running',
      'assistant:done',
    ]);
  });
});

describe('agent machine lifecycle', () => {
  it('runs multiple turns on the same agent', async () => {
    const requester = createStubRequester([
      createAssistantMessage([{ type: 'text', text: 'first' }]),
      createAssistantMessage([{ type: 'text', text: 'second' }]),
    ]);
    const tools: ToolDefinition[] = [];
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    const completedTurns: number[] = [];
    actor.on('turn.done', (event) => completedTurns.push(event.messages.length));
    actor.start();

    actor.send({ type: 'input.submit', message: createUserMessage('hi') });
    await waitFor(actor, (s) => s.matches('idle') && s.context.messages.length === 2, {
      timeout: 5000,
    });

    actor.send({ type: 'input.submit', message: createUserMessage('again') });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 4,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:first',
      'user:again',
      'assistant:second',
    ]);
    expect(completedTurns).toEqual([2, 4]);
    expect(actor.getSnapshot().status).toBe('active');
  });

  it('queues input submitted during a turn and starts a new turn for it afterwards', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'slow_tool')]),
      createAssistantMessage([{ type: 'text', text: 'first' }]),
      createAssistantMessage([{ type: 'text', text: 'second' }]),
    ]);
    let resolveTool: ((result: ToolResult) => void) | undefined;
    const tools = stubTools(
      () =>
        new Promise((resolve) => {
          resolveTool = resolve;
        }),
      'slow_tool',
    );
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(() => {
      expect(resolveTool).toBeDefined();
    });
    actor.send({ type: 'input.submit', message: createUserMessage('mid-turn') });
    expect(actor.getSnapshot().context.queue).toHaveLength(1);
    expect(actor.getSnapshot().context.notifications).toHaveLength(0);

    resolveTool?.({ content: [{ type: 'text', text: 'slow' }] });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 6,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:slow',
      'assistant:first',
      'user:mid-turn',
      'assistant:second',
    ]);
  });

  it('emits turn.failed on llm failure, returns to idle, and accepts new input', async () => {
    let call = 0;
    const requester: LlmRequester = {
      generate: (_config, _content, { onEvent }) => {
        call += 1;
        if (call === 1) {
          onEvent?.({ type: 'llm.failed.remote', error: { kind: 'unknown', message: 'llm down' } });
          return Promise.resolve();
        }
        streamMessage(createAssistantMessage([{ type: 'text', text: 'recovered' }]), onEvent);
        return Promise.resolve();
      },
    };
    const tools: ToolDefinition[] = [];
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    const failures: unknown[] = [];
    actor.on('turn.failed', (event) => failures.push(event.error));
    actor.start();

    actor.send({ type: 'input.submit', message: createUserMessage('hi') });
    const failedSnapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && failures.length === 1,
      { timeout: 5000 },
    );
    expect(rolesAndTexts(failedSnapshot.context.messages)).toEqual(['user:hi']);
    expect(failures[0]).toMatchObject({ kind: 'unknown', message: 'llm down' });
    expect(actor.getSnapshot().status).toBe('active');

    actor.send({ type: 'input.submit', message: createUserMessage('retry') });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 3,
      { timeout: 5000 },
    );
    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'user:retry',
      'assistant:recovered',
    ]);
  });
});

describe('agent machine input.notify', () => {
  it('delivers a notified message at the next thinking step within the turn', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'slow_tool')]),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    let resolveTool: ((result: ToolResult) => void) | undefined;
    const tools = stubTools(
      () =>
        new Promise((resolve) => {
          resolveTool = resolve;
        }),
      'slow_tool',
    );
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(() => {
      expect(resolveTool).toBeDefined();
    });
    actor.send({
      type: 'input.notify',
      message: createUserMessage('<system-reminder>stale</system-reminder>'),
    });
    expect(actor.getSnapshot().context.notifications).toHaveLength(1);

    resolveTool?.({ content: [{ type: 'text', text: 'slow' }] });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 5,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:slow',
      'user:<system-reminder>stale</system-reminder>',
      'assistant:done',
    ]);
  });

  it('ends the turn at a message-only step and starts a new turn for a pending notification', async () => {
    let firstOnEvent: ((event: LlmRequestEvent) => void) | undefined;
    let resolveFirst: (() => void) | undefined;
    let call = 0;
    const requester: LlmRequester = {
      generate: (_config, _content, { onEvent }) => {
        call += 1;
        if (call === 1) {
          firstOnEvent = onEvent;
          return new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        streamMessage(createAssistantMessage([{ type: 'text', text: 'second' }]), onEvent);
        return Promise.resolve();
      },
    };
    const tools: ToolDefinition[] = [];
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    const completedTurns: number[] = [];
    actor.on('turn.done', (event) => completedTurns.push(event.messages.length));
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(() => {
      expect(resolveFirst).toBeDefined();
    });
    actor.send({
      type: 'input.notify',
      message: createUserMessage('<system-reminder>stale</system-reminder>'),
    });
    expect(actor.getSnapshot().context.notifications).toHaveLength(1);

    streamMessage(createAssistantMessage([{ type: 'text', text: 'first' }]), firstOnEvent);
    resolveFirst?.();
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 4,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:first',
      'user:<system-reminder>stale</system-reminder>',
      'assistant:second',
    ]);
    expect(completedTurns).toEqual([2, 4]);
  });

  it('drives a turn immediately for a notification while idle', async () => {
    const requester = createStubRequester([
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    const tools: ToolDefinition[] = [];
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    const llmDone: AssistantEntry[] = [];
    actor.on('llm.done', (event) => {
      llmDone.push(event.entry);
    });
    actor.start();
    actor.send({ type: 'input.notify', message: createUserMessage('queued') });

    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 2,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(snapshot.context.messages)).toEqual(['user:queued', 'assistant:done']);
    expect(llmDone.map((entry) => extractText(entry.message))).toEqual(['done']);
    expect(llmDone[0]?.meta).toEqual({
      model: { provider: 'test', model: 'test-model' },
      source: 'llm',
      usage: emptyUsage(),
      headers: undefined,
      finish: { finishReason: 'completed', rawFinishReason: 'stop' },
      messageId: 'msg-stub',
    });
  });
});

describe('agent machine input.reminder', () => {
  it('stays pending while idle and is delivered at the next turn drain', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'slow_tool')]),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    let resolveTool: ((result: ToolResult) => void) | undefined;
    const tools = stubTools(
      () =>
        new Promise((resolve) => {
          resolveTool = resolve;
        }),
      'slow_tool',
    );
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    const consumedKeys: (string | undefined)[][] = [];
    actor.on('turn.remindersConsumed', (event) => {
      if (event.type === 'turn.remindersConsumed') {
        consumedKeys.push(event.reminders.map((entry) => entry.meta.key));
      }
    });
    actor.start();

    actor.send({
      type: 'input.reminder',
      key: 'todo',
      message: createUserMessage('<system-reminder>\nold\n</system-reminder>'),
    });
    actor.send({
      type: 'input.reminder',
      key: 'todo',
      message: createUserMessage('<system-reminder>\nstale\n</system-reminder>'),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const idleSnapshot = actor.getSnapshot();
    expect(idleSnapshot.matches('idle')).toBe(true);
    expect(idleSnapshot.context.messages).toHaveLength(0);
    expect(idleSnapshot.context.reminders).toHaveLength(1);
    expect(idleSnapshot.context.reminders[0]?.meta).toEqual({ source: 'reminder', key: 'todo' });
    expect(extractText(idleSnapshot.context.reminders[0]?.message ?? createUserMessage(''))).toContain('stale');

    actor.send({ type: 'input.submit', message: createUserMessage('hi') });
    await vi.waitFor(() => {
      expect(resolveTool).toBeDefined();
    });
    expect(actor.getSnapshot().context.reminders).toHaveLength(1);

    resolveTool?.({ content: [{ type: 'text', text: 'slow' }] });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 5,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:slow',
      'user:<system-reminder>\nstale\n</system-reminder>',
      'assistant:done',
    ]);
    expect(snapshot.context.messages[3]?.meta).toEqual({ source: 'reminder', key: 'todo' });
    expect(snapshot.context.reminders).toHaveLength(0);
    expect(consumedKeys).toEqual([['todo']]);
  });
});

describe('agent machine llm retry', () => {
  it('retries a retryable llm failure within the turn and completes', async () => {
    let call = 0;
    const requester: LlmRequester = {
      generate: (_config, _content, { onEvent }) => {
        call += 1;
        onEvent?.({ type: 'llm.sent' });
        if (call === 1) {
          onEvent?.({
            type: 'llm.failed.remote',
            error: {
              kind: 'status',
              statusCode: 500,
              message: 'server error',
              requestId: null,
              retryAfterMs: null,
              headers: null,
            },
          });
          return Promise.resolve();
        }
        streamMessage(createAssistantMessage([{ type: 'text', text: 'recovered' }]), onEvent);
        return Promise.resolve();
      },
    };
    const ticks = [1000, 1100, 1200, 100000, 100100, 100140, 100200];
    const timingPlugin = createTimingPlugin({ now: () => ticks.shift() ?? Number.NaN });
    const tools: ToolDefinition[] = [];
    const actor = createActor(
      createTestAgentMachine(tools, requester, { maxAttemptsPerStep: 3 }),
      {
        input: { request: { model } },
      },
    );
    connectPlugins(actor, [timingPlugin]);
    const retrying: Extract<LlmEvent, { type: 'llm.retrying' }>[] = [];
    const failures: unknown[] = [];
    actor.on('llm.retrying', (event) => retrying.push(event));
    actor.on('turn.failed', (event) => failures.push(event.error));
    actor.start();

    actor.send({ type: 'input.submit', message: createUserMessage('hi') });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 2,
      { timeout: 5000 },
    );

    expect(call).toBe(2);
    expect(retrying).toHaveLength(1);
    expect(retrying[0]).toMatchObject({
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      statusCode: 500,
    });
    expect(failures).toHaveLength(0);
    expect(rolesAndTexts(snapshot.context.messages)).toEqual(['user:hi', 'assistant:recovered']);

    const delayMs = retrying[0]?.delayMs ?? 0;
    expect(timingPlugin.timing()).toEqual({
      requestBuildMs: 100000 - 1200 - delayMs,
      ttftMs: 100100 - 1200 - delayMs,
      serverFirstTokenMs: 100,
      streamDurationMs: 100,
      serverDecodeMs: 60,
      clientConsumeMs: 40,
    });
    expect(ticks).toHaveLength(0);
  });
});

describe('agent machine input.steer', () => {
  it('promotes a queued prompt into the current turn at the next thinking step', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'slow_tool')]),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    let resolveTool: ((result: ToolResult) => void) | undefined;
    const tools = stubTools(
      () =>
        new Promise((resolve) => {
          resolveTool = resolve;
        }),
      'slow_tool',
    );
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(() => {
      expect(resolveTool).toBeDefined();
    });
    actor.send({ type: 'input.submit', id: 'p1', message: createUserMessage('steer me') });
    expect(actor.getSnapshot().context.queue).toHaveLength(1);

    actor.send({ type: 'input.steer', id: 'nope' });
    expect(actor.getSnapshot().context.queue).toHaveLength(1);
    expect(actor.getSnapshot().context.notifications).toHaveLength(0);

    actor.send({ type: 'input.steer', id: 'p1' });
    expect(actor.getSnapshot().context.queue).toHaveLength(0);
    expect(actor.getSnapshot().context.notifications).toHaveLength(1);

    resolveTool?.({ content: [{ type: 'text', text: 'slow' }] });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 5,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:slow',
      'user:steer me',
      'assistant:done',
    ]);
  });
});

describe('agent machine input.abort', () => {
  it('salvages streamed content when aborting an in-flight llm request', async () => {
    const signals: AbortSignal[] = [];
    const requester: LlmRequester = {
      generate: (_config, _content, { signal, onEvent }) => {
        signals.push(signal);
        const parts: StreamedMessagePart[] = [
          { type: 'text', text: 'hel' },
          { type: 'text', text: 'lo' },
          { type: 'function', id: 'call-1', name: 'slow_tool', arguments: '{"incom' },
          { type: 'text', text: '   ' },
        ];
        return new Promise((resolve) => {
          for (const part of parts) {
            onEvent?.({ type: 'llm.delta', part });
          }
          signal.addEventListener('abort', () => {
            onEvent?.({ type: 'llm.failed.remote', error: { kind: 'abort', message: 'aborted' } });
            resolve();
          });
        });
      },
    };
    const tools: ToolDefinition[] = [];
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    const aborted: HistoryMessage[][] = [];
    const aborting: unknown[] = [];
    actor.on('turn.aborted', (event) => aborted.push(event.messages));
    actor.on('turn.aborting', (event) => aborting.push(event));
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    actor.send({ type: 'input.abort' });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && aborted.length === 1,
      { timeout: 5000 },
    );

    expect(signals[0]?.aborted).toBe(true);
    expect(aborting).toHaveLength(1);
    expect(rolesAndTexts(snapshot.context.messages)).toEqual(['user:hi', 'assistant:hello']);
    expect(rolesAndTexts(aborted[0] ?? [])).toEqual(['user:hi', 'assistant:hello']);
    const salvaged = aborted[0]?.[1];
    expect(salvaged?.message.role === 'assistant' && salvaged.message.toolCalls).toEqual([]);
    expect(salvaged?.meta.source).toBe('salvaged');
  });

  it('aborts running turn tools and completes the transcript with aborted tool messages', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'slow_tool')]),
    ]);
    const signals: AbortSignal[] = [];
    const tools = stubTools(({ signal }) => {
      signals.push(signal);
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('tool stopped')));
      });
    }, 'slow_tool');
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    actor.send({ type: 'input.abort' });
    expect(actor.getSnapshot().value).toEqual({ running: 'aborting' });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 3,
      { timeout: 5000 },
    );

    expect(signals[0]?.aborted).toBe(true);
    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:aborted',
    ]);
  });

  it('waits for the real outcome of a tool that settles after the abort signal', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'slow_tool')]),
    ]);
    const tools = stubTools(
      ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'partial' }] }));
        }),
      'slow_tool',
    );
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    const aborted: HistoryMessage[][] = [];
    actor.on('turn.aborted', (event) => aborted.push(event.messages));
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.turnTools['call-1']).toBeDefined();
    });
    actor.send({ type: 'input.abort' });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && aborted.length === 1,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:partial',
    ]);
  });

  it('forces the turn to aborted on a second abort when a tool ignores the signal', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'slow_tool')]),
    ]);
    const signals: AbortSignal[] = [];
    const tools = stubTools(({ signal }) => {
      signals.push(signal);
      return new Promise(() => {});
    }, 'slow_tool');
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    actor.send({ type: 'input.abort' });
    expect(actor.getSnapshot().value).toEqual({ running: 'aborting' });

    actor.send({ type: 'input.abort' });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 3,
      { timeout: 5000 },
    );

    expect(signals[0]?.aborted).toBe(true);
    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:aborted',
    ]);
  });

  it('forces the turn to aborted when tools do not settle before the abort timeout', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'slow_tool')]),
    ]);
    const tools = stubTools(() => new Promise(() => {}), 'slow_tool');
    const actor = createActor(createTestAgentMachine(tools, requester, undefined, 50), {
      input: { request: { model } },
    });
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.turnTools['call-1']).toBeDefined();
    });
    actor.send({ type: 'input.abort' });
    expect(actor.getSnapshot().value).toEqual({ running: 'aborting' });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 3,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:aborted',
    ]);
  });

  it('starts a new turn for queued prompts and notifications after abort', async () => {
    let call = 0;
    const requester: LlmRequester = {
      generate: (_config, _content, { signal, onEvent }) => {
        call += 1;
        if (call === 1) {
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              onEvent?.({
                type: 'llm.failed.remote',
                error: { kind: 'abort', message: 'aborted' },
              });
              resolve();
            });
          });
        }
        streamMessage(createAssistantMessage([{ type: 'text', text: 'second' }]), onEvent);
        return Promise.resolve();
      },
    };
    const tools: ToolDefinition[] = [];
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(() => {
      expect(call).toBe(1);
    });
    actor.send({ type: 'input.submit', id: 'p1', message: createUserMessage('queued') });
    actor.send({ type: 'input.submit', id: 'p2', message: createUserMessage('steered') });
    actor.send({ type: 'input.steer', id: 'p2' });
    actor.send({ type: 'input.abort' });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 4,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'user:steered',
      'user:queued',
      'assistant:second',
    ]);
  });

  it('keeps detached background tools running across an abort', async () => {
    let call = 0;
    const bgSignals: AbortSignal[] = [];
    let resolveBg: ((result: ToolResult) => void) | undefined;
    const requester: LlmRequester = {
      generate: (_config, _content, { signal, onEvent }) => {
        call += 1;
        if (call === 1) {
          streamMessage(createAssistantMessage([], [toolCall('call-1', 'bg_tool')]), onEvent);
          return Promise.resolve();
        }
        if (call === 2) {
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              onEvent?.({
                type: 'llm.failed.remote',
                error: { kind: 'abort', message: 'aborted' },
              });
              resolve();
            });
          });
        }
        streamMessage(createAssistantMessage([{ type: 'text', text: 'done' }]), onEvent);
        return Promise.resolve();
      },
    };
    const tools = stubTools(({ detach, signal }) => {
      bgSignals.push(signal);
      detach?.({ text: 'async running: bg_tool' });
      return new Promise((resolve) => {
        resolveBg = resolve;
      });
    }, 'bg_tool');
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(() => {
      expect(call).toBe(2);
    });
    actor.send({ type: 'input.abort' });
    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toEqual({ idle: 'waiting' });
    });
    expect(bgSignals[0]?.aborted).toBe(false);
    expect(actor.getSnapshot().context.background['call-1']).toBeDefined();

    resolveBg?.({ content: [{ type: 'text', text: 'bg-result' }] });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 5,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:async running: bg_tool',
      'user:[async tool completed] bg_tool (tool_call_id=call-1)\nbg-result',
      'assistant:done',
    ]);
  });
});

describe('agent machine max steps', () => {
  it('resets the step budget on drained input and fails only on pure tool-call continuation', async () => {
    let call = 0;
    const requester: LlmRequester = {
      generate: (_config, _content, { onEvent }) => {
        call += 1;
        streamMessage(createAssistantMessage([], [toolCall(`call-${call}`, 'ok_tool')]), onEvent);
        return Promise.resolve();
      },
    };
    const resolvers: Array<() => void> = [];
    const tools = stubTools(
      () =>
        new Promise((resolve) => {
          resolvers.push(() => resolve({ content: [{ type: 'text', text: 'ok' }] }));
        }),
      'ok_tool',
    );
    const actor = createActor(
      createAgentMachine({
        tools,
        turnActor: createTurnMachine(createLlmMachine({ requester })),
        maxStepsPerTurn: 2,
      }),
      { input: { request: { model } } },
    );
    const failures: Extract<AgentEmitted, { type: 'turn.failed' }>[] = [];
    actor.on('turn.failed', (event) => failures.push(event));
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });

    await vi.waitFor(() => {
      expect(call).toBe(1);
      expect(resolvers).toHaveLength(1);
    });
    resolvers[0]?.();

    await vi.waitFor(() => {
      expect(call).toBe(2);
      expect(resolvers).toHaveLength(2);
    });
    actor.send({ type: 'input.notify', message: createUserMessage('keep going') });
    resolvers[1]?.();

    await vi.waitFor(() => {
      expect(call).toBe(3);
      expect(resolvers).toHaveLength(3);
    });
    resolvers[2]?.();

    await vi.waitFor(() => {
      expect(call).toBe(4);
      expect(resolvers).toHaveLength(4);
    });
    resolvers[3]?.();

    const snapshot = await waitFor(actor, (s) => s.matches('idle') && failures.length === 1, {
      timeout: 5000,
    });

    expect(call).toBe(4);
    expect(failures[0]?.interruptReason).toBe('max_steps');
    expect(failures[0]?.error).toBeInstanceOf(MaxStepsExceededError);
    expect((failures[0]?.error as MaxStepsExceededError).code).toBe('loop.max_steps_exceeded');
    expect((failures[0]?.error as MaxStepsExceededError).details).toEqual({ maxSteps: 2 });
    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:ok',
      'assistant:',
      'tool:ok',
      'user:keep going',
      'assistant:',
      'tool:ok',
      'assistant:',
      'tool:ok',
    ]);
    expect(actor.getSnapshot().status).toBe('active');
  });
});

describe('agent machine context reset', () => {
  it('replaces messages, turnId and branchId when idle', async () => {
    const requester = createStubRequester([
      createAssistantMessage([{ type: 'text', text: 'reply' }]),
    ]);
    const actor = createActor(createTestAgentMachine([], requester), {
      input: { request: { model } },
    });
    actor.start();
    const resets: string[] = [];
    actor.on('context.reset', (event) => {
      if (event.type === 'context.reset') resets.push(event.branchId);
    });
    const turnStarts: Array<{ turnId: number; branchId: string }> = [];
    actor.on('turn.start', (event) => {
      if (event.type === 'turn.start') {
        turnStarts.push({ turnId: event.turnId, branchId: event.branchId });
      }
    });

    actor.send({ type: 'input.submit', message: createUserMessage('hi') });
    await waitFor(actor, (s) => s.matches('idle') && s.context.messages.length === 2, {
      timeout: 5000,
    });

    actor.send({
      type: 'context.reset',
      history: [createUserEntry(createUserMessage('seed'), { source: 'input' })],
      turnId: 0,
      branchId: 'main~2',
    });

    expect(actor.getSnapshot().context.messages).toHaveLength(1);
    expect(actor.getSnapshot().context.turnId).toBe(0);
    expect(actor.getSnapshot().context.branchId).toBe('main~2');
    expect(resets).toEqual(['main~2']);

    actor.send({ type: 'input.submit', message: createUserMessage('again') });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 3,
      { timeout: 5000 },
    );
    expect(snapshot.context.turnId).toBe(1);
    expect(turnStarts).toEqual([
      { turnId: 1, branchId: 'main' },
      { turnId: 1, branchId: 'main~2' },
    ]);
  });

  it('ignores context.reset while running, including a turn driven by notify', async () => {
    let calls = 0;
    const releases: Array<() => void> = [];
    const requester: LlmRequester = {
      generate: (_config, _content, { onEvent }) => {
        calls += 1;
        return new Promise<void>((resolve) => {
          releases.push(() => {
            onEvent?.({ type: 'llm.delta', part: { type: 'text', text: 'late' } });
            onEvent?.({ type: 'llm.done' });
            resolve();
          });
        });
      },
    };
    const actor = createActor(createTestAgentMachine([], requester), {
      input: { request: { model } },
    });
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });
    await vi.waitFor(() => expect(calls).toBe(1));

    actor.send({ type: 'context.reset', history: [], turnId: 0, branchId: 'other' });
    expect(actor.getSnapshot().context.branchId).toBe('main');

    releases[0]?.();
    await waitFor(actor, (s) => s.matches('idle') && s.context.messages.length === 2, {
      timeout: 5000,
    });

    actor.send({ type: 'input.notify', message: createUserMessage('note') });
    await vi.waitFor(() => expect(calls).toBe(2));
    actor.send({ type: 'context.reset', history: [], turnId: 0, branchId: 'other' });
    expect(actor.getSnapshot().context.branchId).toBe('main');

    releases[1]?.();
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 4,
      { timeout: 5000 },
    );
    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:late',
      'user:note',
      'assistant:late',
    ]);
  });
});
