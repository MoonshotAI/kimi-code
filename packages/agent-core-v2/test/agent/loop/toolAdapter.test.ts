import { describe, expect, it, vi } from 'vitest';

import { createTestLoop as createLoop } from './core/factory';
import { createUserEntry, type ToolEntry } from '@moonshot-ai/core/history/history';
import { createUserMessage, extractText, type ToolCall } from '@moonshot-ai/core/llm/message';
import { createMockProviderRequester, type MockProviderResponse } from '../../harness/scripted-generate';
import type { ToolResult } from '@moonshot-ai/core/tool/executor';
import { executorFrom } from './core/executor';

function call(id: string, name = 'Bash'): ToolCall {
  return { type: 'function', id, name, arguments: '{}' };
}

function requester(responses: MockProviderResponse[]) {
  return createMockProviderRequester(responses);
}

function done(text: string, toolCalls: ToolCall[] = []): MockProviderResponse {
  return { parts: [{ type: 'text', text }, ...toolCalls] };
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

describe('actor handler execution', () => {
  it('executes every call in model order without stopBatch or native stopTurn', async () => {
    const executed: string[] = [];
    const executor = executorFrom(['Bash', 'Read'], async ({ toolCall }) => {
      executed.push(toolCall.name);
      return toolCall.id === 't1'
        ? { content: [{ type: 'text', text: 'first' }] }
        : { content: [{ type: 'text', text: 'second failed' }], isError: true };
    });
    const scripted = requester([done('', [call('t1'), call('t2', 'Read')]), done('final')]);
    const loop = createLoop({
      requester: scripted,
      executor,
    });
    const started: string[] = [];
    loop.subscribe((event) => {
      if (event.type === 'tool.started') started.push(event.toolCall.id);
    });

    expect((await loop.runTurn(prompt())).type).toBe('done');
    expect(started).toEqual(['t1', 't2']);
    expect(executed).toEqual(['Bash', 'Read']);
    const entries = loop.state.messages.filter((entry): entry is ToolEntry => entry.message.role === 'tool');
    expect(entries.map((entry) => extractText(entry.message))).toEqual(['first', 'second failed']);
    expect(entries.every((entry) => entry.meta?.stopTurn === undefined)).toBe(true);
    await loop.close();

    const beforeExecuteError = new Error('beforeExecute blew up');
    const failedLoop = createLoop({
      requester: requester([done('', [call('failed')])]),
      executor: executorFrom(['Bash'], async () => ({ content: [] }), [{
        point: 'tool.starting',
        hook: () => {
          throw beforeExecuteError;
        },
      }]),
    });
    const failedProjections: string[] = [];
    failedLoop.subscribe((event) => {
      if (
        event.type === 'tool.started' ||
        event.type === 'tool.ended' ||
        (event.type === 'message.appended' && event.source === 'tool')
      ) failedProjections.push(event.type);
    });
    expect(await failedLoop.runTurn(prompt())).toMatchObject({ type: 'failed', error: beforeExecuteError });
    expect(failedProjections).toEqual([]);
    expect(failedLoop.state.messages.some((entry) => entry.message.role === 'tool')).toBe(false);
    await failedLoop.close();

    const vetoedLoop = createLoop({
      requester: requester([done('', [call('vetoed')]), done('final')]),
      executor: executorFrom(['Bash'], async () => ({ content: [] }), [{
        point: 'tool.starting',
        hook: () => ({
          blocked: { reason: 'denied' },
          result: { content: [{ type: 'text' as const, text: 'synthetic veto' }], isError: true },
        }),
      }]),
    });
    expect((await vetoedLoop.runTurn(prompt())).type).toBe('done');
    const vetoed = vetoedLoop.state.messages.find((entry): entry is ToolEntry => entry.message.role === 'tool');
    expect(vetoed).toBeDefined();
    expect(extractText(vetoed!.message)).toBe('synthetic veto');
    expect(vetoed?.meta?.isError).toBe(true);
    await vetoedLoop.close();
  });

  it('uses one handler for detach, waiting, late completion and close notification', async () => {
    const gate = deferred<void>();
    const executor = executorFrom(['Bash'], async ({ detach }) => {
      detach?.('background task_id=task-bg');
      await gate.promise;
      return { content: [{ type: 'text', text: 'finished' }] };
    });
    const scripted = requester([done('', [call('bg')]), done('next'), done('async')]);
    const loop = createLoop({
      requester: scripted,
      executor,
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
    const closingExecutor = executorFrom(['Bash'], async () => {
      await toolGate.promise;
      return { content: [] };
    });
    const executeClose = closingExecutor.execute.bind(closingExecutor);
    const closingHandlers: Array<ReturnType<typeof closingExecutor.execute>> = [];
    vi.spyOn(closingExecutor, 'execute').mockImplementation((toolCall, context) => {
      const handler = executeClose(toolCall, context);
      closingHandlers.push(handler);
      return handler;
    });
    const closingRequester = requester([done('', [call('close-bg')]), done('next')]);
    const closingLoop = createLoop({
      requester: closingRequester,
      executor: closingExecutor,
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
    const closeStop = vi.spyOn(closingHandlers[0]!, 'stop');
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
    expect(closeStop).toHaveBeenCalled();
    expect(asyncEntries).toEqual(['custom closed']);
    expect(notifications).toEqual([]);

    const rejectionGate = deferred<void>();
    const rejection = new Error('completion factory rejected');
    const rejectedRequester = requester([done('', [call('reject-bg')]), done('next'), done('async failed')]);
    const rejectedLoop = createLoop({
      requester: rejectedRequester,
      executor: executorFrom(['Bash'], async () => {
        await rejectionGate.promise;
        return { content: [{ type: 'text', text: 'ignored successful result' }] };
      }),
    });
    const asyncRejected = rejectedLoop.wait('tool.async_ended');
    const notifiedRejection = rejectedLoop.wait('prompt.notified');
    const rejectedStarted = rejectedLoop.wait('tool.started');
    const rejectedTurn = rejectedLoop.runTurn(prompt());
    await rejectedStarted;
    rejectedLoop.detachTool('reject-bg', 'reject background', () => {
      throw rejection;
    });
    expect((await rejectedTurn).type).toBe('done');
    rejectionGate.resolve();

    const rejectedEvent = await asyncRejected;
    expect(rejectedEvent.outcome).toEqual({ type: 'failed', error: rejection });
    expect(extractText(rejectedEvent.entry.message)).toContain('[async tool failed]');
    expect(extractText(rejectedEvent.entry.message)).toContain('completion factory rejected');
    expect(extractText(rejectedEvent.entry.message)).not.toContain('[async tool completed]');
    expect(extractText((await notifiedRejection).entry.message)).toContain('[async tool failed]');
    expect(rejectedLoop.state.calls).toEqual([]);
    await rejectedLoop.waitForIdle();
    await rejectedLoop.close();

    for (const timing of ['before', 'during', 'after'] as const) {
      const resetGate = deferred<void>();
      const resetExecutor = executorFrom(['Bash'], async ({ detach }) => {
        detach?.('reset background');
        await resetGate.promise;
        return { content: [{ type: 'text', text: 'reset finished' }] };
      });
      const execute = resetExecutor.execute.bind(resetExecutor);
      const handlers: Array<ReturnType<typeof resetExecutor.execute>> = [];
      vi.spyOn(resetExecutor, 'execute').mockImplementation((toolCall, context) => {
        const handler = execute(toolCall, context);
        handlers.push(handler);
        return handler;
      });
      const resetRequester = requester([done('', [call(`reset-${timing}`)]), done('next'), done('async')]);
      const resetLoop = createLoop({
        requester: resetRequester,
        executor: resetExecutor,
      });
      const asyncEvents: string[] = [];
      const appended: string[] = [];
      resetLoop.subscribe((event) => {
        if (event.type === 'tool.async_ended') asyncEvents.push(extractText(event.entry.message));
        if (event.type === 'message.appended' && event.source === 'notify') appended.push(extractText(event.entry.message));
      });
      const detachedReset = resetLoop.wait('tool.ended', { match: (event) => event.detached });
      expect((await resetLoop.runTurn(prompt())).type).toBe('done');
      await detachedReset;
      const stop = vi.spyOn(handlers[0]!, 'stop');
      if (timing === 'before') {
        resetGate.resolve();
        await resetLoop.wait('tool.async_ended');
        await resetLoop.waitForIdle();
      }
      const prepare = deferred<void>();
      const resetting = resetLoop.reset(async () => {
        if (timing === 'during') resetGate.resolve();
        await prepare.promise;
        return {
          messages: resetLoop.state.messages,
          inbox: { notify: resetLoop.state.inbox.notify },
          nextTurnId: 0,
          historyRevision: 0,
        };
      });
      if (timing === 'during') {
        resetLoop.notify(createUserEntry(createUserMessage('live before restored'), { promptId: 'live' }));
        await resetLoop.wait('tool.async_ended');
        expect(resetLoop.state.turn).toBeUndefined();
        expect(resetLoop.state.resetting).toBe(true);
      }
      prepare.resolve();
      await resetting;
      if (timing === 'after') {
        resetGate.resolve();
        await resetLoop.wait('tool.async_ended');
      }
      resetLoop.start();
      await resetLoop.waitForIdle();
      expect(stop).not.toHaveBeenCalled();
      expect(asyncEvents).toHaveLength(1);
      expect(asyncEvents[0]).toContain('[async tool completed]');
      expect(appended.filter((text) => text.includes('[async tool completed]'))).toHaveLength(1);
      if (timing === 'during') expect(appended[0]).toBe('live before restored');
      const usableMessages = resetLoop.state.messages;
      await expect(resetLoop.reset(async () => {
        throw new Error('reset prepare failed');
      })).rejects.toThrow('reset prepare failed');
      expect(resetLoop.state.messages).toBe(usableMessages);
      resetLoop.start();
      await resetLoop.waitForIdle();
      await resetLoop.close();
    }
  });

  it('settles late results only in their original StepCall when an id is reused', async () => {
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const executor = executorFrom(['Bash'], async ({ toolCall, detach }) => {
      const index = gates.length;
      const gate = deferred<void>();
      gates.push(gate);
      if (index === 0) detach?.('old background');
      await gate.promise;
      return { content: [{ type: 'text', text: `${index}:${toolCall.id}` }] };
    });
    const scripted = requester([
      done('', [call('same')]),
      done('first final'),
      done('', [call('same')]),
      done('second final'),
    ]);
    const loop = createLoop({
      requester: scripted,
      executor,
    });
    expect((await loop.runTurn(prompt())).type).toBe('done');
    await vi.waitFor(() => expect(gates).toHaveLength(1));

    let secondSettled = false;
    const secondTurn = loop.runTurn(prompt());
    void secondTurn.then(() => {
      secondSettled = true;
    });
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    const oldCompleted = loop.wait('tool.async_ended');
    gates[0]?.resolve();
    await oldCompleted;
    expect(secondSettled).toBe(false);
    const pendingEntries = loop.state.messages.filter((entry): entry is ToolEntry => entry.message.role === 'tool');
    expect(pendingEntries.map((entry) => extractText(entry.message))).toEqual(['old background']);

    gates[1]?.resolve();
    expect((await secondTurn).type).toBe('done');
    await loop.waitForIdle();
    const entries = loop.state.messages.filter((entry): entry is ToolEntry => entry.message.role === 'tool');
    expect(entries.map((entry) => extractText(entry.message))).toEqual(['old background', '1:same__2']);
    expect(loop.state.messages.some((entry) => extractText(entry.message).includes('0:same'))).toBe(true);
    expect(gates).toHaveLength(2);
    await loop.close();
  });

  it('stops one call without aborting its sibling and contains unknown tools', async () => {
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const secondRelease = deferred<void>();
    const executor = executorFrom(['Bash', 'Read'], async ({ toolCall, signal }) => {
      if (toolCall.name === 'Read') {
        secondStarted.resolve();
        await secondRelease.promise;
        return { content: [{ type: 'text', text: 'read ok' }] };
      }
      firstStarted.resolve();
      return new Promise<ToolResult>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve({ content: [{ type: 'text', text: 'first aborted' }], isError: true });
        }, { once: true });
      });
    });
    const scripted = requester([done('', [call('a'), call('b', 'Read')]), done('final')]);
    const loop = createLoop({
      requester: scripted,
      executor,
    });
    const turn = loop.runTurn(prompt());
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    loop.abortTool('a', 'stop');
    secondRelease.resolve();
    expect((await turn).type).toBe('done');
    const entries = loop.state.messages.filter((entry): entry is ToolEntry => entry.message.role === 'tool');
    expect(entries.map((entry) => entry.meta?.isError)).toEqual([true, undefined]);
    await loop.close();

    const unknownLoop = createLoop({
      requester: requester([done('', [call('x', 'Missing')]), done('final')]),
      executor,
    });
    expect((await unknownLoop.runTurn(prompt())).type).toBe('done');
    const unknown = unknownLoop.state.messages.find((entry): entry is ToolEntry => entry.message.role === 'tool');
    expect(unknown?.meta?.isError).toBe(true);
    await unknownLoop.close();
  });
});
