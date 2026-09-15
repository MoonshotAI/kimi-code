import { describe, expect, it, vi } from 'vitest';
import { createActor, waitFor } from '#/xstate2';
import { xstateInspectionCollector } from '#/xstateInspection';

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
import type { LlmEvent } from '#/llm/requester/actor';
import type { LlmRequester, LlmRequestEvent } from '#/llm/requester/requester';
import type { LlmRetryOptions } from '#/llm/requester/retry';
import { emptyUsage, type TokenUsage } from '#/llm/usage';
import { connectPlugins } from '#/plugin';
import { createTimingPlugin } from '#/timing/plugin';
import { createAgentMachine, type AgentEmitted, type AgentMachineSelf, type PromptGateVerdict, type ScopeFactoryOutput } from '#/agent/machine';
import type { UserPromptOrigin } from '#/agent/origin';
import { estimateMessageTokens, estimateTextTokens } from '#/agent/context-usage';
import { messageAppended, turnEnded } from '#/agent/events';
import { agentSlices, type AgentEventStore } from '#/agent/slices';
import {
  createTurnMachine,
  createUserEntry,
  toInputMessages,
  type AssistantEntry,
  type HistoryMessage,
} from '#/agent/turn';
import { MaxStepsExceededError } from '#/agent/errors';
import { createEventStore } from '#/eventStore/eventStore';
import { journalFromBranch } from '#/eventStore/journal';
import { MemoryBackend } from '#/store/backend/memory';
import { TreeStore } from '#/store/store';
import type { Tree } from '#/store/tree';
import { testScopeFactory } from '#/test/agent/scope-factory';
import { waitForTool } from '#/tool/wait-for';
import { defineTool, type ToolDefinition } from '#/tool/tool';
import type { ToolExecutor, ToolResult } from '#/tool/executor';
import { createToolMachine } from '#/tool/machine';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

function toolCall(id: string, name: string, args: string = '{}'): ToolCall {
  return { type: 'function', id, name, arguments: args };
}

function streamMessage(
  message: AssistantMessage,
  onEvent: ((event: LlmRequestEvent) => void) | undefined,
): void {
  for (const part of [...message.content, ...message.toolCalls]) {
    onEvent?.({ type: 'llm.streaming.part', part });
  }
  onEvent?.({ type: 'llm.streaming.message_id', messageId: 'msg-stub' });
  onEvent?.({
    type: 'llm.streaming.finish',
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

function createTestAgent(
  store: AgentEventStore,
  requester: LlmRequester,
  tools: readonly ToolDefinition[] = [],
  options?: { retry?: LlmRetryOptions; abortTimeoutMs?: number; maxStepsPerTurn?: number },
) {
  return createActor(
    createAgentMachine({
      abortTimeoutMs: options?.abortTimeoutMs,
      maxStepsPerTurn: options?.maxStepsPerTurn,
    }),
    {
      input: {
        request: { model },
        scopeFactory: testScopeFactory({
          store,
          requester,
          tools,
          turnOptions: options?.retry === undefined ? undefined : { retry: options.retry },
        }),
      },
    },
  );
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

async function testStore(): Promise<AgentEventStore> {
  const backend = new MemoryBackend();
  const store = await TreeStore.open(backend, {});
  const tree = await store.tree('test');
  tree.createBranch('main');
  return createEventStore({ journal: journalFromBranch(tree.openBranch('main'), tree), slices: agentSlices });
}

async function seedBranch(tree: Tree, branch: string, texts: readonly string[]): Promise<void> {
  tree.createBranch(branch);
  const seed = await createEventStore({
    journal: journalFromBranch(tree.openBranch(branch), tree),
    slices: agentSlices,
  });
  for (const text of texts) {
    await seed.dispatch(
      messageAppended({ message: createUserEntry(createUserMessage(text), { source: 'input' }) }),
    );
  }
  await seed.dispatch(turnEnded({ turnId: 0, outcome: 'done' }));
  await seed.close();
}

async function runAgent(
  requester: LlmRequester,
  tools: readonly ToolDefinition[],
  retry?: LlmRetryOptions,
): Promise<HistoryMessage[]> {
  const store = await testStore();
  const actor = createTestAgent(store, requester, tools, { retry });
  actor.start();
  actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });
  await waitFor(actor, (s) => s.matches('idle') && store.getState().history.length > 1, {
    timeout: 5000,
  });
  return store.getState().history;
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
          onEvent?.({ type: 'llm.streaming.usage', usage });
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

    const plainRequester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'fail_tool')]),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    const plainTools = stubTools(() => Promise.reject('plain failure'), 'fail_tool');

    const plainMessages = await runAgent(plainRequester, plainTools);

    expect(rolesAndTexts(plainMessages)).toEqual([
      'user:hi',
      'assistant:',
      'tool:plain failure',
      'assistant:done',
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
          onEvent?.({ type: 'llm.streaming.part', part: toolCall('call-1', 'retry_tool') });
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toEqual({ idle: 'waiting' });
    });
    expect(actor.getSnapshot().status).toBe('active');
    expect(
      actor.getSnapshot().context.background['call-1']?.ref.getSnapshot().status,
    ).not.toBe('done');

    resolveBg?.({ content: [{ type: 'text', text: 'bg-result' }] });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 6,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(store.getState().history)).toEqual([
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(resolvers.has('sync_tool')).toBe(true);
    });
    resolvers.get('sync_tool')?.({ content: [{ type: 'text', text: 'sync-ok' }] });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toEqual({ idle: 'waiting' });
    });

    resolvers.get('bg_tool')?.({ content: [{ type: 'text', text: 'bg-result' }] });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 7,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(store.getState().history)).toEqual([
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.turnTools['call-2']).toBeDefined();
    });
    resolveBg?.({ content: [{ type: 'text', text: 'bg-result' }] });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 7,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(store.getState().history)).toEqual([
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(
      () => {
        expect(actor.getSnapshot().value).toEqual({ idle: 'waiting' });
      },
      { timeout: 4000 },
    );
    resolveBg?.({ content: [{ type: 'text', text: 'bg-result' }] });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 8,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(store.getState().history)).toEqual([
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
  it('runs multiple turns on scopeFactory materials and disposes asynchronously on input.close', async () => {
    const seenRequestTools: (readonly string[] | undefined)[] = [];
    const seenRequestModels: unknown[] = [];
    const factoryModel: LlmModel = {
      provider: 'test',
      model: 'factory-model',
      capability: UNKNOWN_CAPABILITY,
    };
    const base = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'factory_tool')]),
      createAssistantMessage([{ type: 'text', text: 'first' }]),
      createAssistantMessage([{ type: 'text', text: 'second' }]),
    ]);
    const requester: LlmRequester = {
      generate: (config, content, control) => {
        seenRequestTools.push(config.tools?.map((tool) => tool.name));
        seenRequestModels.push(config.model);
        return base.generate(config, content, control);
      },
    };
    const executorCalls: string[] = [];
    const factoryExecutor: ToolExecutor = {
      execute: (input) => {
        executorCalls.push(input.toolCall.name);
        return Promise.resolve({ content: [{ type: 'text', text: 'factory-tool-result' }] });
      },
    };
    const factoryTool = defineTool({
      name: 'factory_tool',
      description: 'tool from the scope factory',
      parameters: { type: 'object', properties: {} },
      execute: () => Promise.resolve({ content: [{ type: 'text', text: 'unreachable' }] }),
    });
    const deferredTool = defineTool({
      name: 'deferred_tool',
      description: 'deferred tool from the scope factory',
      parameters: { type: 'object', properties: {} },
      deferred: true,
      execute: () => Promise.resolve({ content: [{ type: 'text', text: 'unreachable' }] }),
    });
    const store = await testStore();
    let factorySelf: AgentMachineSelf | undefined;
    let factorySignal: AbortSignal | undefined;
    let resolveFactory: ((output: ScopeFactoryOutput) => void) | undefined;
    const scopeFactory = (self: AgentMachineSelf, signal: AbortSignal) => {
      factorySelf = self;
      factorySignal = signal;
      return new Promise<ScopeFactoryOutput>((resolve) => {
        resolveFactory = resolve;
      });
    };
    let resolveDispose: (() => void) | undefined;
    const disposeAsync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDispose = resolve;
        }),
    );
    const actor = createActor(createAgentMachine({}), {
      input: { request: { model }, scopeFactory },
    });
    const completedTurns: number[] = [];
    let attachedCount = 0;
    actor.on('turn.done', (event) => completedTurns.push(event.messages.length));
    actor.on('agent.attached', () => {
      attachedCount += 1;
    });
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    expect(actor.getSnapshot().matches('linking')).toBe(true);
    expect(actor.getSnapshot().context.queue).toHaveLength(1);
    expect(store.getState().history).toHaveLength(0);

    (resolveFactory as (output: ScopeFactoryOutput) => void)({
      handle: { disposeAsync },
      store,
      turnLogic: createTurnMachine(requester),
      toolLogic: createToolMachine(factoryExecutor),
      tools: [factoryTool, deferredTool],
      request: { model: factoryModel },
    });
    await waitFor(actor, (s) => s.matches('idle') && store.getState().history.length === 4, {
      timeout: 5000,
    });

    expect(attachedCount).toBe(1);
    expect(factorySelf).toBeDefined();
    expect(typeof (factorySelf as AgentMachineSelf).send).toBe('function');
    expect(typeof (factorySelf as AgentMachineSelf).getSnapshot).toBe('function');
    expect(typeof (factorySelf as AgentMachineSelf).on).toBe('function');
    expect(factorySignal).toBeInstanceOf(AbortSignal);
    expect((factorySignal as AbortSignal).aborted).toBe(false);
    expect(rolesAndTexts(store.getState().history)).toEqual([
      'user:hi',
      'assistant:',
      'tool:factory-tool-result',
      'assistant:first',
    ]);
    expect(executorCalls).toEqual(['factory_tool']);
    expect(seenRequestTools[0]).toEqual(['factory_tool']);
    expect(seenRequestModels).toEqual([factoryModel, factoryModel]);

    actor.send({ type: 'input.submit', entry: { message: createUserMessage('again') } });
    await waitFor(actor, (s) => s.matches('idle') && store.getState().history.length === 6, {
      timeout: 5000,
    });

    expect(rolesAndTexts(store.getState().history)).toEqual([
      'user:hi',
      'assistant:',
      'tool:factory-tool-result',
      'assistant:first',
      'user:again',
      'assistant:second',
    ]);
    expect(completedTurns).toEqual([4, 6]);
    expect(seenRequestModels).toEqual([factoryModel, factoryModel, factoryModel]);
    expect(actor.getSnapshot().status).toBe('active');

    actor.send({ type: 'input.close' });
    await vi.waitFor(() => {
      expect(disposeAsync).toHaveBeenCalledTimes(1);
    });
    expect(actor.getSnapshot().status).toBe('active');
    expect(actor.getSnapshot().matches('closing')).toBe(true);

    (resolveDispose as () => void)();
    await waitFor(actor, (s) => s.status === 'done', { timeout: 5000 });
    expect(actor.getSnapshot().value).toBe('disposed');
    expect(attachedCount).toBe(1);
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(resolveTool).toBeDefined();
    });
    actor.send({
      type: 'input.submit',
      entry: {
        message: createUserMessage('mid-turn'),
        meta: {
          promptId: 'mid',
          origin: { kind: 'user' },
          tracked: true,
          createdAt: '2026-09-14T00:00:00.000Z',
          userMessageId: 'umid-1',
        },
      },
    });
    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.queue).toHaveLength(1);
      expect(actor.getSnapshot().context.notifications).toHaveLength(0);
    });
    expect(actor.getSnapshot().context.queue[0]).toEqual({
      message: createUserMessage('mid-turn'),
      meta: {
        source: 'input',
        promptId: 'mid',
        origin: { kind: 'user' },
        tracked: true,
        createdAt: '2026-09-14T00:00:00.000Z',
        userMessageId: 'umid-1',
      },
    });

    resolveTool?.({ content: [{ type: 'text', text: 'slow' }] });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 6,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(store.getState().history)).toEqual([
      'user:hi',
      'assistant:',
      'tool:slow',
      'assistant:first',
      'user:mid-turn',
      'assistant:second',
    ]);
  });

  it('emits turn.failed on llm failure, recovers, and emits agent.failed when linking fails', async () => {
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    const failures: unknown[] = [];
    actor.on('turn.failed', (event) => failures.push(event.error));
    actor.start();

    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });
    await waitFor(
      actor,
      (s) => s.matches('idle') && failures.length === 1,
      { timeout: 5000 },
    );
    await vi.waitFor(() => {
      expect(rolesAndTexts(store.getState().history)).toEqual(['user:hi']);
    });
    expect(failures[0]).toMatchObject({ kind: 'unknown', message: 'llm down' });
    expect(actor.getSnapshot().status).toBe('active');

    actor.send({ type: 'input.submit', entry: { message: createUserMessage('retry') } });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 3,
      { timeout: 5000 },
    );
    expect(rolesAndTexts(store.getState().history)).toEqual([
      'user:hi',
      'user:retry',
      'assistant:recovered',
    ]);

    const linkError = new Error('scope factory failed');
    const linkFailures: unknown[] = [];
    const linkingActor = createActor(createAgentMachine({}), {
      input: { request: { model }, scopeFactory: () => Promise.reject(linkError) },
    });
    linkingActor.on('agent.failed', (event) => linkFailures.push(event.error));
    linkingActor.start();
    await waitFor(linkingActor, (s) => s.status === 'done', { timeout: 5000 });
    expect(linkFailures).toEqual([linkError]);
    expect(linkingActor.getSnapshot().value).toBe('disposed');
  });

  it('persists turn events without reporting unhandled store.changed and closes directly while linking', async () => {
    const unhandledStoreChanged: unknown[] = [];
    const unsubscribe = xstateInspectionCollector.subscribe((envelope) => {
      if (envelope.eventType === 'store.changed' && envelope.unhandled === true) {
        unhandledStoreChanged.push(envelope);
      }
    });
    try {
      const requester = createStubRequester([
        createAssistantMessage([{ type: 'text', text: 'hi' }]),
      ]);
      const store = await testStore();
      const actor = createTestAgent(store, requester);
      actor.start();
      actor.send({ type: 'input.submit', entry: { message: createUserMessage('hello') } });
      await waitFor(actor, (s) => s.matches('idle') && store.getState().history.length === 2, {
        timeout: 5000,
      });
      await store.flush();
      expect(unhandledStoreChanged).toEqual([]);
    } finally {
      unsubscribe();
    }

    const visitedStates: unknown[] = [];
    const linkingFailures: unknown[] = [];
    const pendingActor = createActor(createAgentMachine({}), {
      input: {
        request: { model },
        scopeFactory: () => new Promise<ScopeFactoryOutput>(() => {}),
      },
    });
    pendingActor.on('agent.failed', (event) => linkingFailures.push(event.error));
    pendingActor.subscribe((snapshot) => visitedStates.push(snapshot.value));
    pendingActor.start();
    expect(pendingActor.getSnapshot().matches('linking')).toBe(true);
    pendingActor.send({ type: 'input.close' });
    await waitFor(pendingActor, (s) => s.status === 'done', { timeout: 5000 });
    expect(pendingActor.getSnapshot().value).toBe('disposed');
    expect(visitedStates).not.toContain('closing');
    expect(linkingFailures).toEqual([]);
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(resolveTool).toBeDefined();
    });
    actor.send({
      type: 'input.notify',
      entry: { message: createUserMessage('<system-reminder>stale</system-reminder>') },
    });
    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.notifications).toHaveLength(1);
    });

    resolveTool?.({ content: [{ type: 'text', text: 'slow' }] });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 5,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(store.getState().history)).toEqual([
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    const completedTurns: number[] = [];
    actor.on('turn.done', (event) => completedTurns.push(event.messages.length));
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(resolveFirst).toBeDefined();
    });
    actor.send({
      type: 'input.notify',
      entry: { message: createUserMessage('<system-reminder>stale</system-reminder>') },
    });
    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.notifications).toHaveLength(1);
    });

    streamMessage(createAssistantMessage([{ type: 'text', text: 'first' }]), firstOnEvent);
    resolveFirst?.();
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 4,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(store.getState().history)).toEqual([
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    const llmDone: AssistantEntry[] = [];
    actor.on('llm.done', (event) => {
      llmDone.push(event.entry);
    });
    actor.start();
    actor.send({ type: 'input.notify', entry: { message: createUserMessage('queued') } });

    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 2,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(store.getState().history)).toEqual(['user:queued', 'assistant:done']);
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

describe('agent machine input.remind', () => {
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    const consumedKeys: (string | undefined)[][] = [];
    actor.on('turn.reminders_consumed', (event) => {
      if (event.type === 'turn.reminders_consumed') {
        consumedKeys.push(event.reminders.map((entry) => entry.meta?.key));
      }
    });
    actor.start();

    actor.send({
      type: 'input.remind',
      key: 'todo',
      entry: { message: createUserMessage('<system-reminder>\nold\n</system-reminder>') },
    });
    actor.send({
      type: 'input.remind',
      key: 'todo',
      entry: { message: createUserMessage('<system-reminder>\nstale\n</system-reminder>') },
    });
    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.reminders).toHaveLength(1);
    });
    expect(actor.getSnapshot().matches('idle')).toBe(true);
    expect(store.getState().history).toHaveLength(0);
    expect(actor.getSnapshot().context.reminders).toHaveLength(1);
    expect(actor.getSnapshot().context.reminders[0]?.meta).toEqual({ source: 'reminder', key: 'todo' });
    expect(extractText(actor.getSnapshot().context.reminders[0]?.message ?? createUserMessage(''))).toContain('stale');

    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });
    await vi.waitFor(() => {
      expect(resolveTool).toBeDefined();
    });
    expect(actor.getSnapshot().context.reminders).toHaveLength(1);

    resolveTool?.({ content: [{ type: 'text', text: 'slow' }] });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 5,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(store.getState().history)).toEqual([
      'user:hi',
      'assistant:',
      'tool:slow',
      'user:<system-reminder>\nstale\n</system-reminder>',
      'assistant:done',
    ]);
    expect(store.getState().history[3]?.meta).toEqual({ source: 'reminder', key: 'todo' });
    expect(actor.getSnapshot().context.reminders).toHaveLength(0);
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools, { retry: { maxAttemptsPerStep: 3 } });
    connectPlugins(actor, [timingPlugin]);
    const retrying: Extract<LlmEvent, { type: 'llm.retrying' }>[] = [];
    const failures: unknown[] = [];
    actor.on('llm.retrying', (event) => retrying.push(event));
    actor.on('turn.failed', (event) => failures.push(event.error));
    actor.start();

    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 2,
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
    expect(rolesAndTexts(store.getState().history)).toEqual(['user:hi', 'assistant:recovered']);

    const delayMs = retrying[0]?.delayMs ?? 0;
    expect(timingPlugin.timing()).toEqual({
      requestBuildMs: 100000 - (1200 + delayMs),
      ttftMs: 100100 - (1200 + delayMs),
      serverFirstTokenMs: 100,
      streamDurationMs: 100,
      serverDecodeMs: 60,
      clientConsumeMs: 40,
    });
    expect(ticks).toHaveLength(0);
  });
});

describe('agent machine input.steer', () => {
  it('promotes queued prompts into the current turn and merges multi-id steers in FIFO order', async () => {
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    const steered: string[][] = [];
    actor.on('prompt.steered', (event) => steered.push(event.queueItemIds));
    const p2Origin: UserPromptOrigin = {
      kind: 'user',
      skillActivations: [{ activationId: 'a1', skillName: 'demo' }],
    };
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(resolveTool).toBeDefined();
    });
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('steer me'), meta: { promptId: 'p1' } } });
    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.queue).toHaveLength(1);
    });

    actor.send({ type: 'input.steer', id: 'nope' });
    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.queue).toHaveLength(1);
      expect(actor.getSnapshot().context.notifications).toHaveLength(0);
    });
    expect(steered).toEqual([]);

    actor.send({ type: 'input.steer', id: 'p1' });
    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.queue).toHaveLength(0);
      expect(actor.getSnapshot().context.notifications).toHaveLength(1);
    });
    expect(steered).toEqual([['p1']]);

    actor.send({
      type: 'input.submit',
      entry: {
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'SKILLBLOCK' },
            { type: 'text', text: 'p2 body' },
          ],
        },
        meta: { promptId: 'p2', origin: p2Origin },
      },
    });
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('third'), meta: { promptId: 'p3' } } });
    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.queue).toHaveLength(2);
    });

    actor.send({ type: 'input.steer', id: ['p2', 'p3'] });
    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.queue).toHaveLength(0);
      expect(actor.getSnapshot().context.notifications).toHaveLength(2);
    });
    expect(steered).toEqual([['p1'], ['p2', 'p3']]);
    expect(actor.getSnapshot().context.notifications[1]?.message.content).toEqual([
      { type: 'text', text: 'SKILLBLOCK' },
      { type: 'text', text: 'p2 body' },
      { type: 'text', text: 'third' },
    ]);

    resolveTool?.({ content: [{ type: 'text', text: 'slow' }] });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 6,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(store.getState().history)).toEqual([
      'user:hi',
      'assistant:',
      'tool:slow',
      'user:steer me',
      'user:SKILLBLOCK\np2 body\nthird',
      'assistant:done',
    ]);
  });
});

describe('agent machine prompt gate', () => {
  it('commits a gate-rewritten message and drops the head on a boolean block or a gate failure', async () => {
    const requester = createStubRequester([
      createAssistantMessage([{ type: 'text', text: 'rewritten reply' }]),
    ]);
    const store = await testStore();
    const gateCalls: string[] = [];
    let gateImpl: () => PromptGateVerdict = () => ({
      block: false,
      message: createUserMessage('rewritten'),
    });
    const actor = createActor(createAgentMachine({}), {
      input: {
        request: { model },
        scopeFactory: testScopeFactory({
          store,
          requester,
          promptGate: (_id, message) => {
            gateCalls.push(extractText(message));
            return Promise.resolve(gateImpl());
          },
        }),
      },
    });
    const blocked: (string | undefined)[] = [];
    const failed: unknown[] = [];
    actor.on('prompt.blocked', (event) => blocked.push(event.queueItemId));
    actor.on('prompt.gate_failed', (event) => failed.push(event.error));
    actor.start();

    actor.send({ type: 'input.submit', entry: { message: createUserMessage('original'), meta: { promptId: 'g1' } } });
    await waitFor(actor, (s) => s.matches('idle') && store.getState().history.length === 2, {
      timeout: 5000,
    });
    expect(rolesAndTexts(store.getState().history)).toEqual([
      'user:rewritten',
      'assistant:rewritten reply',
    ]);
    expect(gateCalls).toEqual(['original']);

    gateImpl = () => true;
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('blocked'), meta: { promptId: 'g2' } } });
    await vi.waitFor(() => {
      expect(blocked).toEqual(['g2']);
    });
    expect(actor.getSnapshot().context.queue).toHaveLength(0);
    expect(store.getState().history).toHaveLength(2);

    gateImpl = () => {
      throw new Error('gate down');
    };
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('explode'), meta: { promptId: 'g3' } } });
    await vi.waitFor(() => {
      expect(failed).toHaveLength(1);
    });
    expect(String(failed[0])).toContain('gate down');
    expect(actor.getSnapshot().context.queue).toHaveLength(0);
    expect(store.getState().history).toHaveLength(2);
    expect(actor.getSnapshot().matches('idle')).toBe(true);
    expect(gateCalls).toEqual(['original', 'blocked', 'explode']);
    actor.stop();
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
            onEvent?.({ type: 'llm.streaming.part', part });
          }
          signal.addEventListener('abort', () => {
            onEvent?.({ type: 'llm.failed.remote', error: { kind: 'abort', message: 'aborted' } });
            resolve();
          });
        });
      },
    };
    const tools: ToolDefinition[] = [];
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    const aborted: HistoryMessage[][] = [];
    const aborting: unknown[] = [];
    actor.on('turn.aborted', (event) => aborted.push(event.messages));
    actor.on('turn.aborting', (event) => aborting.push(event));
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    actor.send({ type: 'input.abort' });
    await waitFor(
      actor,
      (s) => s.matches('idle') && aborted.length === 1,
      { timeout: 5000 },
    );

    expect(signals[0]?.aborted).toBe(true);
    expect(aborting).toHaveLength(1);
    await vi.waitFor(() => {
      expect(rolesAndTexts(store.getState().history)).toEqual(['user:hi', 'assistant:hello']);
    });
    expect(rolesAndTexts(aborted[0] ?? [])).toEqual(['user:hi', 'assistant:hello']);
    const salvaged = aborted[0]?.[1];
    expect(salvaged?.message.role === 'assistant' && salvaged.message.toolCalls).toEqual([]);
    expect(salvaged?.meta?.source).toBe('salvaged');
  });

  it('forwards the abort reason to the in-flight llm request signal', async () => {
    const signals: AbortSignal[] = [];
    const requester: LlmRequester = {
      generate: (_config, _content, { signal, onEvent }) => {
        signals.push(signal);
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            onEvent?.({ type: 'llm.failed.remote', error: { kind: 'abort', message: 'aborted' } });
            resolve();
          });
        });
      },
    };
    const store = await testStore();
    const actor = createTestAgent(store, requester, []);
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });
    await vi.waitFor(() => {
      expect(signals).toHaveLength(1);
    });

    const reason = new Error('stop requested by the user');
    actor.send({ type: 'input.abort', reason });
    await waitFor(actor, (s) => s.matches('idle'), { timeout: 5000 });

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[0]?.reason).toBe(reason);
  });

  it('aborts running turn tools and completes the transcript with aborted tool messages', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'slow_tool')]),
      createAssistantMessage([{ type: 'text', text: 'resumed' }], []),
    ]);
    const signals: AbortSignal[] = [];
    const tools = stubTools(({ signal }) => {
      signals.push(signal);
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('tool stopped')));
      });
    }, 'slow_tool');
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    actor.send({ type: 'input.abort' });
    expect(actor.getSnapshot().value).toEqual({ running: 'aborting' });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 3,
      { timeout: 5000 },
    );

    expect(signals[0]?.aborted).toBe(true);
    expect(rolesAndTexts(store.getState().history)).toEqual([
      'user:hi',
      'assistant:',
      'tool:aborted',
    ]);

    actor.send({ type: 'input.continue' });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 4,
      { timeout: 5000 },
    );
    expect(rolesAndTexts(store.getState().history)).toEqual([
      'user:hi',
      'assistant:',
      'tool:aborted',
      'assistant:resumed',
    ]);
    expect(store.getState().turnIndex.nextTurnId).toBe(2);
  });

  it('forwards the abort reason to the signals of running turn tools', async () => {
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'slow_tool')]),
      createAssistantMessage([{ type: 'text', text: 'resumed' }], []),
    ]);
    const signals: AbortSignal[] = [];
    const tools = stubTools(({ signal }) => {
      signals.push(signal);
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    }, 'slow_tool');
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });
    await vi.waitFor(() => {
      expect(signals).toHaveLength(1);
    });

    const reason = new Error('stop requested by the user');
    actor.send({ type: 'input.abort', reason });
    await waitFor(actor, (s) => s.matches('idle'), { timeout: 5000 });

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[0]?.reason).toBe(reason);
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    const aborted: HistoryMessage[][] = [];
    actor.on('turn.aborted', (event) => aborted.push(event.messages));
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.turnTools['call-1']).toBeDefined();
    });
    actor.send({ type: 'input.abort' });
    await waitFor(
      actor,
      (s) => s.matches('idle') && aborted.length === 1,
      { timeout: 5000 },
    );

    await vi.waitFor(() => {
      expect(rolesAndTexts(store.getState().history)).toEqual([
        'user:hi',
        'assistant:',
        'tool:partial',
      ]);
    });
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    actor.send({ type: 'input.abort' });
    expect(actor.getSnapshot().value).toEqual({ running: 'aborting' });

    actor.send({ type: 'input.abort' });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 3,
      { timeout: 5000 },
    );

    expect(signals[0]?.aborted).toBe(true);
    expect(rolesAndTexts(store.getState().history)).toEqual([
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools, { abortTimeoutMs: 50 });
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.turnTools['call-1']).toBeDefined();
    });
    actor.send({ type: 'input.abort' });
    expect(actor.getSnapshot().value).toEqual({ running: 'aborting' });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 3,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(store.getState().history)).toEqual([
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(call).toBe(1);
    });
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('queued'), meta: { promptId: 'p1' } } });
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('steered'), meta: { promptId: 'p2' } } });
    actor.send({ type: 'input.steer', id: 'p2' });
    actor.send({ type: 'input.abort' });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 4,
      { timeout: 5000 },
    );

    expect(rolesAndTexts(store.getState().history)).toEqual([
      'user:hi',
      'user:steered',
      'user:queued',
      'assistant:second',
    ]);
  });

  it('keeps detached background tools running across an abort and aborts them on stop', async () => {
    let call = 0;
    const bgSignals: AbortSignal[] = [];
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
      return new Promise(() => {});
    }, 'bg_tool');
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(call).toBe(2);
    });
    actor.send({ type: 'input.abort' });
    await vi.waitFor(() => {
      expect(actor.getSnapshot().value).toEqual({ idle: 'waiting' });
    });
    expect(bgSignals[0]?.aborted).toBe(false);
    expect(actor.getSnapshot().context.background['call-1']).toBeDefined();

    actor.stop();
    expect(bgSignals[0]?.aborted).toBe(true);
  });
});

describe('agent machine input.pause/input.continue', () => {
  it('gates queue drain while paused and resumes on continue', async () => {
    const requester = createStubRequester([
      createAssistantMessage([{ type: 'text', text: 'hi there' }], []),
    ]);
    const store = await testStore();
    const actor = createTestAgent(store, requester);
    actor.start();
    actor.send({ type: 'input.pause' });
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.queue).toHaveLength(1);
    });
    expect(actor.getSnapshot().matches('running')).toBe(false);

    actor.send({ type: 'input.continue' });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 2,
      { timeout: 5000 },
    );
    expect(rolesAndTexts(store.getState().history)).toEqual(['user:hi', 'assistant:hi there']);
    expect(actor.getSnapshot().context.paused).toBe(false);
    actor.stop();
  });

  it('ends the turn at the acting boundary when paused and resumes with a new turn on continue', async () => {
    let calls = 0;
    const base = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'fast_tool')]),
      createAssistantMessage([{ type: 'text', text: 'final' }], []),
    ]);
    const requester: LlmRequester = {
      generate: (config, content, control) => {
        calls += 1;
        return base.generate(config, content, control);
      },
    };
    let releaseTool: (() => void) | undefined;
    const tools = stubTools(
      () =>
        new Promise((resolve) => {
          releaseTool = () => resolve({ content: [{ type: 'text', text: 'tool result' }] });
        }),
      'fast_tool',
    );
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools);
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.turnTools['call-1']).toBeDefined();
    });
    actor.send({ type: 'input.pause' });
    (releaseTool as () => void)();

    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 3,
      { timeout: 5000 },
    );
    expect(rolesAndTexts(store.getState().history)).toEqual([
      'user:hi',
      'assistant:',
      'tool:tool result',
    ]);
    expect(calls).toBe(1);
    expect(store.getState().turnIndex.nextTurnId).toBe(1);

    actor.send({ type: 'input.continue' });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 4,
      { timeout: 5000 },
    );
    expect(rolesAndTexts(store.getState().history)).toEqual([
      'user:hi',
      'assistant:',
      'tool:tool result',
      'assistant:final',
    ]);
    expect(calls).toBe(2);
    expect(store.getState().turnIndex.nextTurnId).toBe(2);
    actor.stop();
  });

  it('does not start a turn on continue when history ends with a plain assistant message', async () => {
    let calls = 0;
    const base = createStubRequester([
      createAssistantMessage([{ type: 'text', text: 'done' }], []),
    ]);
    const requester: LlmRequester = {
      generate: (config, content, control) => {
        calls += 1;
        return base.generate(config, content, control);
      },
    };
    const store = await testStore();
    const actor = createTestAgent(store, requester);
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 2,
      { timeout: 5000 },
    );

    actor.send({ type: 'input.continue' });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(actor.getSnapshot().matches('idle')).toBe(true);
    expect(store.getState().history).toHaveLength(2);
    expect(calls).toBe(1);
    actor.stop();
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
    const store = await testStore();
    const actor = createTestAgent(store, requester, tools, { maxStepsPerTurn: 2 });
    const failures: Extract<AgentEmitted, { type: 'turn.failed' }>[] = [];
    actor.on('turn.failed', (event) => failures.push(event));
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });

    await vi.waitFor(() => {
      expect(call).toBe(1);
      expect(resolvers).toHaveLength(1);
    });
    resolvers[0]?.();

    await vi.waitFor(() => {
      expect(call).toBe(2);
      expect(resolvers).toHaveLength(2);
    });
    actor.send({ type: 'input.notify', entry: { message: createUserMessage('keep going') } });
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

    await waitFor(actor, (s) => s.matches('idle') && failures.length === 1, {
      timeout: 5000,
    });

    expect(call).toBe(4);
    expect(failures[0]?.interruptReason).toBe('max_steps');
    expect(failures[0]?.error).toBeInstanceOf(MaxStepsExceededError);
    expect((failures[0]?.error as MaxStepsExceededError).code).toBe('loop.max_steps_exceeded');
    expect((failures[0]?.error as MaxStepsExceededError).details).toEqual({ maxSteps: 2 });
    await vi.waitFor(() => {
      expect(rolesAndTexts(store.getState().history)).toEqual([
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
    });
    expect(actor.getSnapshot().status).toBe('active');
  });
});

describe('agent machine context reset', () => {
  it('replaces messages and branchId when idle without rewinding the turn clock', async () => {
    const requester = createStubRequester([
      createAssistantMessage([{ type: 'text', text: 'reply' }]),
    ]);
    const backend = new MemoryBackend();
    const treeStore = await TreeStore.open(backend, {});
    const tree = await treeStore.tree('test');
    tree.createBranch('main');
    const store = await createEventStore({
      journal: journalFromBranch(tree.openBranch('main'), tree),
      slices: agentSlices,
    });
    const actor = createTestAgent(store, requester);
    actor.start();
    const resets: string[] = [];
    actor.on('context.reset', (event) => {
      if (event.type === 'context.reset') resets.push(event.branchId);
    });
    const turnStarts: Array<{ turnId: number; branchId: string }> = [];
    actor.on('turn.started', (event) => {
      if (event.type === 'turn.started') {
        turnStarts.push({ turnId: event.turnId, branchId: event.branchId });
      }
    });

    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });
    await waitFor(actor, (s) => s.matches('idle') && store.getState().history.length === 2, {
      timeout: 5000,
    });

    await seedBranch(tree, 'main~2', ['seed']);
    await store.reset(journalFromBranch(tree.openBranch('main~2'), tree));

    await vi.waitFor(() => {
      expect(resets).toEqual(['main~2']);
    });
    expect(store.ref.branch).toBe('main~2');
    expect(store.getState().history).toHaveLength(1);
    expect(store.getState().turnIndex.nextTurnId).toBe(1);

    actor.send({ type: 'input.submit', entry: { message: createUserMessage('again') } });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 3,
      { timeout: 5000 },
    );
    expect(store.getState().turnIndex.nextTurnId).toBe(2);
    expect(turnStarts).toEqual([
      { turnId: 0, branchId: 'main' },
      { turnId: 1, branchId: 'main~2' },
    ]);

    actor.send({ type: 'input.pause' });
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('queued'), meta: { promptId: 'q1' } } });
    await vi.waitFor(() => {
      expect(actor.getSnapshot().context.queue).toHaveLength(1);
    });

    await seedBranch(tree, 'main~3', ['third-seed']);
    await store.reset(journalFromBranch(tree.openBranch('main~3'), tree));

    await vi.waitFor(() => {
      expect(resets).toEqual(['main~2', 'main~3']);
    });
    expect(store.getState().history).toHaveLength(1);
    expect(actor.getSnapshot().context.queue).toEqual([
      { message: createUserMessage('queued'), meta: { source: 'input', promptId: 'q1' } },
    ]);

    actor.send({ type: 'input.continue' });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 3,
      { timeout: 5000 },
    );
    expect(rolesAndTexts(store.getState().history)).toEqual([
      'user:third-seed',
      'user:queued',
      'assistant:reply',
    ]);
    expect(turnStarts).toEqual([
      { turnId: 0, branchId: 'main' },
      { turnId: 1, branchId: 'main~2' },
      { turnId: 1, branchId: 'main~3' },
    ]);
  });

  it('aborts an in-flight turn and applies the new state on store.reset while running', async () => {
    let calls = 0;
    const signals: AbortSignal[] = [];
    const releases: Array<() => void> = [];
    const requester: LlmRequester = {
      generate: (_config, _content, { signal, onEvent }) => {
        calls += 1;
        signals.push(signal);
        return new Promise<void>((resolve) => {
          releases.push(() => {
            onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'late' } });
            onEvent?.({ type: 'llm.done' });
            resolve();
          });
        });
      },
    };
    const backend = new MemoryBackend();
    const treeStore = await TreeStore.open(backend, {});
    const tree = await treeStore.tree('test');
    tree.createBranch('main');
    const store = await createEventStore({
      journal: journalFromBranch(tree.openBranch('main'), tree),
      slices: agentSlices,
    });
    const actor = createTestAgent(store, requester);
    actor.start();
    actor.send({ type: 'input.submit', entry: { message: createUserMessage('hi') } });
    await vi.waitFor(() => expect(calls).toBe(1));

    await seedBranch(tree, 'other', ['seeded']);
    await store.reset(journalFromBranch(tree.openBranch('other'), tree));

    await waitFor(actor, (s) => s.matches('idle') && store.ref.branch === 'other', {
      timeout: 5000,
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(rolesAndTexts(store.getState().history)).toEqual(['user:seeded']);

    releases[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(rolesAndTexts(store.getState().history)).toEqual(['user:seeded']);

    actor.send({ type: 'input.notify', entry: { message: createUserMessage('note') } });
    await vi.waitFor(() => expect(calls).toBe(2));

    await seedBranch(tree, 'third', ['third-seed']);
    await store.reset(journalFromBranch(tree.openBranch('third'), tree));

    await waitFor(actor, (s) => s.matches('idle') && store.ref.branch === 'third', {
      timeout: 5000,
    });
    expect(signals[1]?.aborted).toBe(true);
    expect(rolesAndTexts(store.getState().history)).toEqual(['user:third-seed']);

    releases[1]?.();
  });
});
