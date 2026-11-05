import { describe, expect, it, vi } from 'vitest';

import type {
  IAgentToolExecutorService,
  ToolExecutorExecuteOptions,
  ToolExecutionResult,
} from '#/agent/toolExecutor/toolExecutor';
import { createCoreTools } from '#/agent/loop/toolAdapter';
import type { LoopLlmRequester } from '#/agent/loop/core/index';
import { createTestLoop as createLoop } from './core/factory';
import { createUserEntry, type ToolEntry } from '#human/agent/turn';
import { createAssistantMessage, createUserMessage, extractText, type ToolCall } from '#human/llm/message';
import type { LlmRequest } from '#human/llm/request';
import type { LlmOutcome } from '#human/llm/response';
import type { ToolExecuteInput } from '#human/tool/executor';
import type { ToolInfo } from '#/tool/toolContract';

const toolInfos: ToolInfo[] = [
  { name: 'Bash', description: 'run a command', source: 'builtin' },
  { name: 'Read', description: 'read a file', source: 'builtin' },
];

function call(id: string, name = 'Bash'): ToolCall {
  return { type: 'function', id, name, arguments: '{}' };
}

function input(toolCall: ToolCall, signal = new AbortController().signal): ToolExecuteInput {
  return { toolCall, signal };
}

function requester(outcomes: (() => LlmOutcome)[]): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async () => {
      const next = outcomes.shift();
      if (next === undefined) throw new Error('unexpected generate');
      return next();
    },
  };
  return self;
}

function done(text: string, toolCalls: ToolCall[] = []): () => LlmOutcome {
  return () => ({ type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) });
}

function prompt() {
  return createUserEntry(createUserMessage('work'));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe('core tool adapter', () => {
  it('collects expected calls into one service batch and maps adjudication, stopTurn and extras', async () => {
    const batches: string[][] = [];
    const executeOptions: ToolExecutorExecuteOptions[] = [];
    const steerController = new AbortController();
    const toolExecutor = {
      execute: async function* (calls: ToolCall[], options: ToolExecutorExecuteOptions) {
        batches.push(calls.map((toolCall) => toolCall.id));
        executeOptions.push(options);
        for (const toolCall of calls) {
          options.onToolCall?.({ toolCallId: toolCall.id, name: toolCall.name, args: {} });
          yield {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            result:
              toolCall.id === 't1'
                ? { output: 'stop', stopTurn: true, stopBatchAfterThis: true, note: 'done' }
                : { output: 'skipped', isError: true },
            durationMs: 7,
          } satisfies ToolExecutionResult;
        }
      },
    } as unknown as IAgentToolExecutorService;
    const onToolResult = vi.fn();
    const tools = createCoreTools({
      toolExecutor,
      toolInfos: () => toolInfos,
      turnId: () => 9,
      steerSignal: () => steerController.signal,
      onToolResult,
    });
    tools.sync();
    const loop = createLoop({
      createTurnExecution: ({ profile }) => ({ profile, requester: requester([done('', [call('t1'), call('t2', 'Read')])]) }),
      executor: tools.executor,
      hooks: [{ point: 'tool.batch-starting', hook: (event) => tools.beginBatch(event.toolCalls) }],
    });
    const started: string[] = [];
    loop.subscribe((event) => {
      if (event.type === 'tool.started') started.push(event.toolCall.id);
    });

    const outcome = await loop.runTurn(prompt());

    expect(outcome.type).toBe('done');
    expect(batches).toEqual([['t1', 't2']]);
    expect(started).toEqual(['t1', 't2']);
    expect(executeOptions[0]?.turnId).toBe(9);
    expect(executeOptions[0]?.steerSignal).toBe(steerController.signal);
    expect(onToolResult).toHaveBeenCalledWith('t1', expect.objectContaining({ stopTurn: true }), 7);
    expect(tools.extras.get('t1')).toMatchObject({ stopTurn: true, stopBatchAfterThis: true, note: 'done' });
    expect(loop.state.messages.filter((entry): entry is ToolEntry => entry.message.role === 'tool')[0]?.meta?.stopTurn).toBe(true);
    await loop.close();
  });

  it('uses the same core slot for detach, task waiting and late completion notification', async () => {
    const gate = deferred<void>();
    const toolExecutor = {
      execute: async function* (calls: ToolCall[], options: ToolExecutorExecuteOptions) {
        options.onToolCall?.({ toolCallId: 'bg', name: 'Bash', args: {} });
        options.detach?.('bg', 'background task_id=task-bg');
        await gate.promise;
        yield {
          toolCallId: 'bg',
          toolName: 'Bash',
          result: { output: 'finished' },
          durationMs: 3,
        } satisfies ToolExecutionResult;
      },
    } as unknown as IAgentToolExecutorService;
    const tools = createCoreTools({ toolExecutor, toolInfos: () => toolInfos, turnId: () => 1 });
    tools.sync();
    const scripted = requester([done('', [call('bg')]), done('next'), done('async')]);
    const loop = createLoop({
      createTurnExecution: ({ profile }) => ({ profile, requester: scripted }),
      executor: tools.executor,
      hooks: [{ point: 'tool.batch-starting', hook: (event) => tools.beginBatch(event.toolCalls) }],
    });
    const detached = loop.wait('tool.ended', { match: (event) => event.detached });
    const turn = loop.runTurn(prompt());

    const detachedEvent = await detached;
    expect(extractText(detachedEvent.outcome.entry.message)).toBe('background task_id=task-bg');
    expect(await loop.waitForTasks({ taskId: 'bg', timeoutMs: 0 })).toMatchObject({ running: ['bg'] });
    expect((await turn).type).toBe('done');
    gate.resolve();
    expect(await loop.waitForTasks({ taskId: 'bg', timeoutMs: 1000 })).toMatchObject({ completed: ['bg'] });
    await loop.waitForIdle();
    expect(loop.state.messages.some((entry) => extractText(entry.message).includes('[async tool completed]'))).toBe(true);
    await loop.close();

    const toolGate = deferred<void>();
    const completion = deferred<ReturnType<typeof prompt>>();
    let requestCompletion: () => void = () => undefined;
    const completionRequested = new Promise<void>((resolve) => {
      requestCompletion = resolve;
    });
    const closingLoop = createLoop({
      createTurnExecution: ({ profile }) => ({
        profile,
        requester: requester([done('', [call('close-bg')]), done('next')]),
      }),
      executor: {
        execute: async () => {
          await toolGate.promise;
          return { content: [] };
        },
      },
    });
    const asyncEntries: string[] = [];
    const notifications: string[] = [];
    closingLoop.subscribe((event) => {
      if (event.type === 'tool.async_ended') asyncEntries.push(extractText(event.entry.message));
      if (event.type === 'prompt.notified') notifications.push(extractText(event.entry.message));
    });
    const started = closingLoop.wait('tool.started');
    const active = closingLoop.runTurn(prompt());
    await started;
    const detachedClose = closingLoop.wait('tool.ended', { match: (event) => event.detached });
    closingLoop.detachTool('close-bg', 'closing', () => {
      requestCompletion();
      return completion.promise;
    });
    await detachedClose;
    expect((await active).type).toBe('done');
    toolGate.resolve();
    await completionRequested;
    const closing = closingLoop.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    completion.resolve(createUserEntry(createUserMessage('custom closed'), {
      source: 'async-tool',
      toolCallId: 'close-bg',
    }));
    await closing;
    expect(asyncEntries).toEqual(['custom closed']);
    expect(notifications).toEqual([]);
  });

  it('settles late results only in their original batch when an id is reused', async () => {
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const batches: string[][] = [];
    const toolExecutor = {
      execute: async function* (calls: ToolCall[]) {
        const index = batches.length;
        const gate = deferred<void>();
        gates.push(gate);
        batches.push(calls.map((toolCall) => toolCall.id));
        await gate.promise;
        for (const toolCall of calls) {
          yield {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            result: { output: `${index}:${toolCall.id}` },
            durationMs: 1,
          } satisfies ToolExecutionResult;
        }
      },
    } as unknown as IAgentToolExecutorService;
    const tools = createCoreTools({ toolExecutor, toolInfos: () => toolInfos, turnId: () => 1 });
    tools.sync();
    const bash = tools.tools.find((tool) => tool.name === 'Bash');
    if (bash === undefined) throw new Error('missing Bash');

    tools.beginBatch([call('same')]);
    const old = bash.execute(input(call('same')));
    const current = bash.execute(input(call('same')));
    gates[1]?.resolve();
    expect((await current).content).toEqual([{ type: 'text', text: '1:same' }]);
    gates[0]?.resolve();
    expect((await old).content).toEqual([{ type: 'text', text: '0:same' }]);
    expect(batches).toEqual([['same'], ['same']]);
    expect(tools.extras.get('same')?.output).toBe('1:same');
  });

  it('settles pending aborts and reports unknown tools through adjudication', async () => {
    const execute = vi.fn();
    const tools = createCoreTools({
      toolExecutor: { execute } as unknown as IAgentToolExecutorService,
      toolInfos: () => toolInfos,
      turnId: () => 1,
    });
    tools.sync();
    const bash = tools.tools.find((tool) => tool.name === 'Bash');
    const read = tools.tools.find((tool) => tool.name === 'Read');
    if (bash === undefined || read === undefined) throw new Error('missing tools');
    const controller = new AbortController();

    tools.beginBatch([call('a'), call('b', 'Read')]);
    const first = bash.execute(input(call('a'), controller.signal));
    controller.abort('stop');
    const second = read.execute(input(call('b', 'Read')));

    expect((await first).isError).toBe(true);
    expect((await second).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    const onAdjudicated = vi.fn();
    const unknown = await tools.executor.execute({ ...input(call('x', 'Missing')), onAdjudicated });
    expect(unknown).toMatchObject({ isError: true });
    expect(onAdjudicated).toHaveBeenCalledWith(call('x', 'Missing'));
  });
});
