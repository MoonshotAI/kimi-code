// ToolExecutor 公开契约测试；历史 issue/PR 来源在具体用例前标注，其余为当前 handler 行为基线。
import { describe, expect, it, vi } from 'vitest';

import { memoryOutputStore } from '#/tool/output-store';
import { isToolDetachAck, textToolContent, ToolExecutor } from '#/tool/tool-executor';
import type {
  ExecutableTool,
  ToolCall,
  ToolDetachAck,
  ToolExecutionResponse,
} from '#/tool/types';
import { setClock } from '#/utils/clock';
import { setLog, type LogArgs, type LogContext } from '#/utils/log';
import { setNow } from '#/utils/now';

type TestTool = ExecutableTool<Record<string, unknown>, unknown, Record<string, unknown>, unknown>;
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  readonly level: LogLevel;
  readonly context?: LogContext;
  readonly message: string;
}

function toolCall(id: string, name: string, args: unknown = {}): ToolCall {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

function defineTool(name: string, overrides: Partial<TestTool> = {}): TestTool {
  return {
    name,
    description: `${name} description`,
    parameters: { type: 'object', additionalProperties: true },
    execute: () => ({ content: textToolContent('done') }),
    ...overrides,
  };
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function captureLogs(): LogEntry[] {
  const entries: LogEntry[] = [];
  const record = (level: LogLevel) => (...args: LogArgs): void => {
    entries.push(args.length === 1
      ? { level, message: args[0] }
      : { level, context: args[0], message: args[1] });
  };
  setLog({
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  });
  return entries;
}

describe('ToolExecutor', () => {
  it('generates normalized task ids with an eight-character suffix and unique values', async () => {
    const executor = new ToolExecutor([defineTool(' Read / HTTP ')]);
    const first = executor.execute(toolCall('task-id-1', ' Read / HTTP '), undefined);
    const second = executor.execute(toolCall('task-id-2', ' Read / HTTP '), undefined);

    expect(first.taskId).toMatch(/^read-http-[0-9a-z]{8}$/);
    expect(second.taskId).toMatch(/^read-http-[0-9a-z]{8}$/);
    expect(first.taskId).not.toBe(second.taskId);
    await Promise.all([first.wait(), second.wait()]);
  });

  it('uses the task prefix when a tool name has no alphanumeric characters', async () => {
    const handler = new ToolExecutor([defineTool('---')]).execute(toolCall('task-id-fallback', '---'), undefined);

    expect(handler.taskId).toMatch(/^task-[0-9a-z]{8}$/);
    await handler.wait();
  });

  it('runs the full lifecycle with the established created boundary', async () => {
    const events: string[] = [];
    const tool = defineTool('lifecycle', {
      prepare: () => {
        events.push('prepare');
        return { type: 'execute', prepared: { ready: true } };
      },
      execute: (context) => {
        expect(context.prepared).toEqual({ ready: true });
        events.push('execute');
        return { content: textToolContent('done') };
      },
    });
    const executor = new ToolExecutor([tool], {
      hook: {
        validating: () => {
          events.push('validating');
        },
        starting: () => {
          events.push('starting');
        },
        permitting: () => {
          events.push('permitting');
        },
        beforeExecute: () => {
          events.push('before-execute');
        },
        afterExecute: () => {
          events.push('after-execute');
        },
        observe: (event) => {
          if (event.type === 'created') events.push('created');
        },
      },
    });

    const handler = executor.execute(toolCall('lifecycle-1', 'lifecycle'), undefined);
    expect(events).toEqual(['validating', 'prepare', 'created']);
    expect((await handler.wait()).outcome.type).toBe('success');
    expect(events).toEqual([
      'validating',
      'prepare',
      'created',
      'starting',
      'permitting',
      'before-execute',
      'execute',
      'after-execute',
    ]);
  });

  it('reprepares rewritten starting args and skips permitting', async () => {
    const preparedArgs: unknown[] = [];
    const validating = vi.fn();
    const permitting = vi.fn();
    const execute = vi.fn(() => ({ content: textToolContent('rewritten') }));
    const tool = defineTool('starting-rewrite', {
      prepare: (context) => {
        preparedArgs.push(context.args);
        return { type: 'execute', prepared: context.args };
      },
      execute,
    });
    const executor = new ToolExecutor([tool], {
      hook: {
        validating,
        starting: () => ({ args: { value: 2 }, skipPermitting: true }),
        permitting,
      },
    });

    const result = await executor.execute(
      toolCall('starting-rewrite-1', 'starting-rewrite', { value: 1 }),
      undefined,
    ).wait();
    expect(result.outcome.type).toBe('success');
    expect(preparedArgs).toEqual([{ value: 1 }, { value: 2 }]);
    expect(validating).toHaveBeenCalledTimes(1);
    expect(permitting).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      args: { value: 2 },
      prepared: { value: 2 },
    }));
  });

  it('reprepares rewritten permitting args without restarting the pipeline', async () => {
    const preparedArgs: unknown[] = [];
    const starting = vi.fn();
    const execute = vi.fn(() => ({ content: textToolContent('rewritten') }));
    const tool = defineTool('permitting-rewrite', {
      prepare: (context) => {
        preparedArgs.push(context.args);
        return { type: 'execute', prepared: context.args };
      },
      execute,
    });
    const executor = new ToolExecutor([tool], {
      hook: {
        starting,
        permitting: () => ({ args: { value: 'permitted' } }),
      },
    });

    const result = await executor.execute(
      toolCall('permitting-rewrite-1', 'permitting-rewrite', { value: 'initial' }),
      undefined,
    ).wait();
    expect(result.outcome.type).toBe('success');
    expect(starting).toHaveBeenCalledTimes(1);
    expect(preparedArgs).toEqual([{ value: 'initial' }, { value: 'permitted' }]);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      args: { value: 'permitted' },
      prepared: { value: 'permitted' },
    }));
  });

  it('short-circuits a rejected decision with its synthetic result', async () => {
    const execute = vi.fn(() => ({ content: textToolContent('must not run') }));
    const afterExecute = vi.fn();
    const executor = new ToolExecutor([defineTool('rejected', { execute })], {
      hook: {
        starting: () => ({
          reject: 'not allowed',
          result: { content: textToolContent('synthetic rejection') },
        }),
        afterExecute,
      },
    });

    const result = await executor.execute(toolCall('rejected-1', 'rejected'), undefined).wait();
    expect(result).toMatchObject({
      toolCallId: 'rejected-1',
      content: textToolContent('synthetic rejection'),
      outcome: {
        type: 'failed',
        error: { type: 'rejected', phase: 'starting', reason: 'not allowed' },
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(afterExecute).toHaveBeenCalledTimes(1);
  });

  it('maps malformed args, unknown tools and missing execute functions to stable errors', async () => {
    const execute = vi.fn(() => ({ content: textToolContent('must not run') }));
    const executor = new ToolExecutor([
      defineTool('available', { execute }),
      defineTool('prepare-only', { execute: undefined }),
    ]);

    const malformed = await executor.execute({
      ...toolCall('malformed-1', 'available'),
      arguments: '{',
    }, undefined).wait();
    const unknown = await executor.execute(toolCall('unknown-1', 'missing'), undefined).wait();
    const missingExecute = await executor.execute(
      toolCall('prepare-only-1', 'prepare-only'),
      undefined,
    ).wait();

    expect(malformed.outcome).toMatchObject({
      type: 'failed',
      error: { type: 'invalid', phase: 'parse' },
    });
    expect(unknown.outcome).toMatchObject({
      type: 'failed',
      error: { type: 'resolve', phase: 'resolve', reason: 'Tool "missing" not found' },
    });
    expect(missingExecute.outcome).toMatchObject({
      type: 'failed',
      error: { type: 'resolve', phase: 'resolve', reason: 'Tool "prepare-only" has no execute function' },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps pre-execution hook rejections separate from execution failures', async () => {
    const startingExecutor = new ToolExecutor([defineTool('starting-error')], {
      hook: {
        starting: () => {
          throw new Error('starting failed');
        },
      },
    });
    const startingHandler = startingExecutor.execute(
      toolCall('starting-error-1', 'starting-error'),
      undefined,
    );
    const startingResponse = Promise.resolve(startingHandler);
    await expect(startingHandler.wait()).rejects.toThrow('starting failed');
    await expect(startingResponse).rejects.toThrow('starting failed');

    const beforeExecutor = new ToolExecutor([defineTool('before-error')], {
      hook: {
        beforeExecute: () => {
          throw new Error('before failed');
        },
      },
    });
    const beforeHandler = beforeExecutor.execute(toolCall('before-error-1', 'before-error'), undefined);
    const beforeResponse = Promise.resolve(beforeHandler);
    await expect(beforeHandler.wait()).rejects.toThrow('before failed');
    await expect(beforeResponse).rejects.toThrow('before failed');

    const executeExecutor = new ToolExecutor([defineTool('execute-error', {
      execute: () => {
        throw new Error('execute failed');
      },
    })]);
    const result = await executeExecutor.execute(toolCall('execute-error-1', 'execute-error'), undefined).wait();
    expect(result.outcome).toMatchObject({
      type: 'failed',
      error: { type: 'unknown', phase: 'execute', reason: 'Tool "execute-error" failed: execute failed' },
    });
  });

  it('exposes live afterExecute fields and preserves the original call id', async () => {
    const tool = defineTool('after-fields', {
      execute: (context) => {
        context.set({ progress: 1 });
        return { content: textToolContent('raw') };
      },
    });
    const executor = new ToolExecutor([tool], {
      hook: {
        afterExecute: (context) => {
          expect(context.fields).toEqual({ progress: 1 });
          context.set({ progress: 2, done: true });
          expect(context.fields).toEqual({ progress: 2, done: true });
          return {
            toolCallId: 'replacement-id',
            content: textToolContent('replacement'),
            outcome: { type: 'success' },
          };
        },
      },
    });

    const handler = executor.execute(toolCall('after-fields-1', 'after-fields'), undefined);
    const result = await handler.wait();
    expect(result).toEqual({
      toolCallId: 'after-fields-1',
      content: textToolContent('replacement'),
      outcome: { type: 'success' },
    });
    expect(handler.fields()).toEqual({ progress: 2, done: true });
  });

  it('preserves an aborted outcome when afterExecute replaces the result', async () => {
    const started = deferred();
    const tool = defineTool('after-aborted', {
      execute: async (context) => {
        started.resolve();
        return new Promise((resolve) => {
          context.signal.addEventListener('abort', () => {
            resolve({ content: textToolContent('stopped') });
          }, { once: true });
        });
      },
    });
    const executor = new ToolExecutor([tool], {
      hook: {
        afterExecute: () => ({
          toolCallId: 'replacement-id',
          content: textToolContent('after replacement'),
          outcome: { type: 'success' },
        }),
      },
    });

    const handler = executor.execute(toolCall('after-aborted-1', 'after-aborted'), undefined);
    await started.promise;
    const result = await handler.stop('cancel');
    expect(result).toMatchObject({
      toolCallId: 'after-aborted-1',
      content: textToolContent('after replacement'),
      outcome: { type: 'aborted', error: { type: 'stopped', reason: 'cancel' } },
    });
  });

  it('returns the default detach ack while wait continues to the real result', async () => {
    const started = deferred();
    const release = deferred();
    const tool = defineTool('default-detach', {
      execute: async () => {
        started.resolve();
        await release.promise;
        return { content: textToolContent('finished') };
      },
    });
    const handler = new ToolExecutor([tool]).execute(
      toolCall('default-detach-1', 'default-detach'),
      undefined,
    );
    const response = Promise.resolve(handler);
    await started.promise;

    const ack = handler.detach('later');
    expect(ack).toBeDefined();
    expect(isToolDetachAck(ack!)).toBe(true);
    expect(ack).toMatchObject({ detached: true, taskId: handler.taskId, toolCallId: 'default-detach-1' });
    expect(ack?.content[0]).toMatchObject({
      text: expect.stringContaining(`task_id: ${handler.taskId}`),
    });
    expect(ack?.content[0]).toMatchObject({ text: expect.stringContaining('phase: execute') });
    expect(handler.detach('again')).toBe(ack);
    expect(await response).toBe(ack);

    release.resolve();
    expect(await handler.wait()).toMatchObject({
      content: textToolContent('finished'),
      outcome: { type: 'success' },
    });
  });

  it('resolves a created-observer detach ack while wait continues to completion', async () => {
    const execute = vi.fn(() => ({ content: textToolContent('finished') }));
    let ack: ToolDetachAck | undefined;
    let response: Promise<ToolExecutionResponse> | undefined;
    const executor = new ToolExecutor([defineTool('created-detach', { execute })], {
      hook: {
        observe: (event) => {
          if (event.type !== 'created') return;
          ack = event.handler.detach('background at created');
          response = Promise.resolve(event.handler);
        },
      },
    });

    const handler = executor.execute(toolCall('created-detach-1', 'created-detach'), undefined);
    expect(ack).toMatchObject({
      detached: true,
      taskId: handler.taskId,
      toolCallId: 'created-detach-1',
    });
    await expect(response!).resolves.toBe(ack);
    expect(await handler.wait()).toMatchObject({
      content: textToolContent('finished'),
      outcome: { type: 'success' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('falls back to the policy detach ack when the tool ack fails', async () => {
    const started = deferred();
    const release = deferred();
    const logs = captureLogs();
    const tool = defineTool('fallback-detach', {
      execute: async (context) => {
        context.onDetach(() => {
          throw new Error('detach ack failed');
        });
        started.resolve();
        await release.promise;
        return { content: textToolContent('finished') };
      },
    });
    const handler = new ToolExecutor([tool], {
      detached: () => ({ content: textToolContent('policy fallback') }),
    }).execute(toolCall('fallback-detach-1', 'fallback-detach'), undefined);
    await started.promise;

    const ack = handler.detach('later');
    expect(ack?.content).toEqual(textToolContent('policy fallback'));
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'warn',
      context: expect.objectContaining({
        type: 'tool.detach_ack_failed',
        toolCallId: 'fallback-detach-1',
        reason: 'detach ack failed',
      }),
    }));
    release.resolve();
    expect((await handler.wait()).outcome.type).toBe('success');
  });

  it('isolates policy and handler observer failures', async () => {
    const observed: string[] = [];
    const tool = defineTool('observers', {
      execute: (context) => {
        context.set({ running: true });
        context.write('output');
        return { content: textToolContent('done') };
      },
    });
    const executor = new ToolExecutor([tool], {
      hook: {
        observe: () => {
          throw new Error('policy observer failed');
        },
      },
    });
    const handler = executor.execute(toolCall('observers-1', 'observers'), undefined);
    handler.observe(() => {
      throw new Error('handler observer failed');
    });
    handler.observe((event) => {
      observed.push(event.type);
    });

    expect((await handler.wait()).outcome.type).toBe('success');
    expect(observed).toContain('change');
    expect(observed).toContain('output');
    expect(handler.output().preview).toBe('output');
  });

  it('uses custom error content and settles plainly when renderError fails', async () => {
    const failingTool = defineTool('render-error', {
      execute: () => {
        throw new Error('raw failure');
      },
    });
    const custom = new ToolExecutor([failingTool], {
      renderError: () => textToolContent('custom error'),
    });
    const customResult = await custom.execute(toolCall('render-error-1', 'render-error'), undefined).wait();
    expect(customResult.content).toEqual(textToolContent('custom error'));
    expect(customResult.outcome.type).toBe('failed');

    const fallback = new ToolExecutor([failingTool], {
      renderError: () => {
        throw new Error('renderer failed');
      },
    });
    const fallbackResult = await fallback.execute(toolCall('render-error-2', 'render-error'), undefined).wait();
    expect(fallbackResult.outcome).toMatchObject({
      type: 'failed',
      error: { phase: 'execute', reason: 'Tool "render-error" failed: renderer failed' },
    });
    expect(fallbackResult.content).toEqual(textToolContent('Tool "render-error" failed: renderer failed'));
  });

  it('replaces tools by name and only removes the currently registered object', async () => {
    const first = defineTool('replaceable', {
      execute: () => ({ content: textToolContent('first') }),
    });
    const second = defineTool('replaceable', {
      execute: () => ({ content: textToolContent('second') }),
    });
    const executor = new ToolExecutor([first]);

    expect(executor.removeExecute(second)).toBe(false);
    executor.addExecute(second);
    expect(executor.list()).toEqual([second]);
    expect(executor.removeExecute(first)).toBe(false);
    const result = await executor.execute(toolCall('replaceable-1', 'replaceable'), undefined).wait();
    expect(result.content).toEqual(textToolContent('second'));
    expect(executor.removeExecute(second)).toBe(true);
    expect(executor.list()).toEqual([]);
    const missing = await executor.execute(toolCall('replaceable-2', 'replaceable'), undefined).wait();
    expect(missing.outcome).toMatchObject({ type: 'failed', error: { type: 'resolve' } });
  });

  // 来源：PR #3966 的执行耗时与 PR #3987 的单调时钟诉求；只测 core handler，不涉及模型 wall-time 投影。
  // https://github.com/MoonshotAI/kimi-code/pull/3966
  // https://github.com/MoonshotAI/kimi-code/pull/3987
  it('settles success, business failure and execution timing distinctly', async () => {
    let wall = 1_000;
    let monotonic = 100;
    setNow(() => (wall += 1_000));
    setClock(() => (monotonic += 5));

    const succeeded = new ToolExecutor([defineTool('timed-success')]).execute(
      toolCall('timed-success-1', 'timed-success'),
      undefined,
    );
    expect(await succeeded.wait()).toMatchObject({
      toolCallId: 'timed-success-1',
      content: textToolContent('done'),
      outcome: { type: 'success' },
    });
    expect(succeeded.snapshot().timing.total).toMatchObject({
      endedAt: expect.any(Number),
      elapsedMs: expect.any(Number),
    });
    expect(succeeded.snapshot().timing.total.elapsedMs).toBeGreaterThan(0);
    expect(succeeded.snapshot().timing.execute?.endedAt).not.toBeNull();
    expect(succeeded.snapshot().timing.execute?.elapsedMs).toBeGreaterThan(0);

    const failed = new ToolExecutor([defineTool('business-failure', {
      execute: () => ({
        content: textToolContent('business failure'),
        outcome: 'failed',
        subtype: 'timeout',
        reason: 'invalid business state',
      }),
    })]).execute(toolCall('business-failure-1', 'business-failure'), undefined);
    expect(await failed.wait()).toMatchObject({
      content: textToolContent('business failure'),
      outcome: {
        type: 'failed',
        error: { type: 'timeout', phase: 'execute', reason: 'invalid business state' },
      },
    });
    expect(failed.snapshot().error).toMatchObject({ outcome: 'failed', type: 'timeout' });
  });

  it('returns a custom detach ack while wait timeout and abort only affect waiting', async () => {
    const started = deferred();
    const release = deferred();
    const tool = defineTool('custom-detach', {
      execute: async (context) => {
        context.onDetach((reason) => ({ content: textToolContent(`background: ${String(reason)}`) }));
        started.resolve();
        await release.promise;
        return { content: textToolContent('finished') };
      },
    });
    const handler = new ToolExecutor([tool]).execute(
      toolCall('custom-detach-1', 'custom-detach'),
      undefined,
    );
    const response = Promise.resolve(handler);
    await started.promise;

    const ack = handler.detach('later');
    expect(ack).toMatchObject({
      detached: true,
      taskId: handler.taskId,
      content: textToolContent('background: later'),
    });
    await expect(handler.wait(5)).rejects.toMatchObject({ name: 'ToolTimeoutError' });
    const controller = new AbortController();
    const reason = new Error('stop waiting only');
    const waiting = handler.wait(undefined, controller.signal);
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(handler.snapshot()).toMatchObject({ status: 'running', detached: true });

    release.resolve();
    expect(await handler.wait()).toMatchObject({
      content: textToolContent('finished'),
      outcome: { type: 'success' },
    });
    expect(await response).toBe(ack);
  });

  it('stops one execution without aborting another handler', async () => {
    const firstStarted = deferred();
    const secondStarted = deferred();
    const secondRelease = deferred();
    let secondSignal: AbortSignal | undefined;
    const executor = new ToolExecutor([
      defineTool('first-stop', {
        execute: async (context) => {
          firstStarted.resolve();
          return new Promise((resolve) => {
            context.signal.addEventListener('abort', () => {
              resolve({ content: textToolContent('first stopped') });
            }, { once: true });
          });
        },
      }),
      defineTool('second-stop', {
        execute: async (context) => {
          secondSignal = context.signal;
          secondStarted.resolve();
          await secondRelease.promise;
          return { content: textToolContent('second finished') };
        },
      }),
    ]);
    const first = executor.execute(toolCall('first-stop-1', 'first-stop'), undefined);
    const second = executor.execute(toolCall('second-stop-1', 'second-stop'), undefined);
    await Promise.all([firstStarted.promise, secondStarted.promise]);

    const stopped = first.stop('cancel first');
    expect(await stopped).toMatchObject({
      content: textToolContent('first stopped'),
      outcome: { type: 'aborted', error: { type: 'stopped', reason: 'cancel first' } },
    });
    expect(await first.stop('already stopped')).toBe(await stopped);
    expect(secondSignal?.aborted).toBe(false);
    expect(second.snapshot().status).toBe('running');

    secondRelease.resolve();
    expect((await second.wait()).outcome.type).toBe('success');
  });

  it('calls stopping once and accepts asynchronous abandon only once', async () => {
    const started = deferred();
    const abandon = deferred();
    let stoppingCalls = 0;
    const tool = defineTool('async-abandon', {
      execute: async () => {
        started.resolve();
        return new Promise<never>(() => {});
      },
      stopping: (context) => {
        stoppingCalls += 1;
        void abandon.promise.then(() => {
          context.abandon({ content: textToolContent('abandoned fallback') });
          context.abandon({ content: textToolContent('duplicate abandon') });
        });
      },
    });
    const handler = new ToolExecutor([tool]).execute(
      toolCall('async-abandon-1', 'async-abandon'),
      undefined,
    );
    let finalChanges = 0;
    handler.observe((event) => {
      if (event.type === 'change' && event.snapshot.status === 'aborted') finalChanges += 1;
    });
    await started.promise;

    const stopping = handler.stop('halt');
    const repeated = handler.stop('halt again');
    expect(repeated).toBe(stopping);
    await Promise.resolve();
    expect(stoppingCalls).toBe(1);

    abandon.resolve();
    expect(await stopping).toMatchObject({
      content: textToolContent('abandoned fallback'),
      outcome: { type: 'aborted', error: { type: 'abandoned', reason: 'halt' } },
    });
    expect(stoppingCalls).toBe(1);
    expect(finalChanges).toBe(1);
  });

  it('threads returned durations through results and keeps them across afterExecute replacements', async () => {
    const executor = new ToolExecutor([
      defineTool('timed', {
        execute: () => ({ content: textToolContent('done'), durationMs: 1_234 }),
      }),
      defineTool('timed-failure', {
        execute: () => ({
          content: textToolContent('bad'),
          outcome: 'failed',
          reason: 'bad',
          durationMs: 7,
        }),
      }),
    ]);

    expect(await executor.execute(toolCall('timed-1', 'timed'), undefined).wait()).toMatchObject({
      outcome: { type: 'success' },
      durationMs: 1_234,
    });
    expect(
      await executor.execute(toolCall('timed-failure-1', 'timed-failure'), undefined).wait(),
    ).toMatchObject({ outcome: { type: 'failed' }, durationMs: 7 });
    const untimed = await new ToolExecutor([defineTool('untimed')])
      .execute(toolCall('untimed-1', 'untimed'), undefined)
      .wait();
    expect('durationMs' in untimed).toBe(false);

    const replacing = new ToolExecutor([
      defineTool('replaced', {
        execute: () => ({ content: textToolContent('raw'), durationMs: 55 }),
      }),
    ], {
      hook: {
        afterExecute: (context) => ({ ...context.result, content: textToolContent('replaced') }),
      },
    });
    expect(await replacing.execute(toolCall('replaced-1', 'replaced'), undefined).wait()).toMatchObject({
      content: textToolContent('replaced'),
      durationMs: 55,
    });
  });

  it('threads stopping-announced durations into abandoned results', async () => {
    const startedWithValue = deferred();
    const withValue = new ToolExecutor([
      defineTool('abandon-value', {
        execute: async () => {
          startedWithValue.resolve();
          return new Promise<never>(() => {});
        },
        stopping: (context) => context.abandon({ content: textToolContent('partial'), durationMs: 2_000 }),
      }),
    ]).execute(toolCall('abandon-value-1', 'abandon-value'), undefined);
    await startedWithValue.promise;
    expect(await withValue.stop('halt')).toMatchObject({
      content: textToolContent('partial'),
      outcome: { type: 'aborted', error: { type: 'abandoned', reason: 'halt' } },
      durationMs: 2_000,
    });

    const startedBare = deferred();
    const bare = new ToolExecutor([
      defineTool('abandon-bare', {
        execute: async () => {
          startedBare.resolve();
          return new Promise<never>(() => {});
        },
        stopping: (context) => context.abandon(undefined, 3_000),
      }),
    ]).execute(toolCall('abandon-bare-1', 'abandon-bare'), undefined);
    await startedBare.promise;
    expect(await bare.stop('halt')).toMatchObject({
      outcome: { type: 'aborted', error: { type: 'abandoned', reason: 'halt' } },
      durationMs: 3_000,
    });

    const startedNone = deferred();
    const none = new ToolExecutor([
      defineTool('abandon-none', {
        execute: async () => {
          startedNone.resolve();
          return new Promise<never>(() => {});
        },
        stopping: (context) => context.abandon(),
      }),
    ]).execute(toolCall('abandon-none-1', 'abandon-none'), undefined);
    await startedNone.promise;
    const noneResult = await none.stop('halt');
    expect(noneResult.outcome).toMatchObject({ type: 'aborted', error: { type: 'abandoned' } });
    expect('durationMs' in noneResult).toBe(false);
  });

  it('seals responses after execute settles so late stop and detach are ignored', async () => {
    const afterEntered = deferred();
    const afterRelease = deferred();
    let executionSignal: AbortSignal | undefined;
    const tool = defineTool('sealed', {
      execute: (context) => {
        executionSignal = context.signal;
        return { content: textToolContent('raw') };
      },
    });
    const executor = new ToolExecutor([tool], {
      hook: {
        afterExecute: async (context) => {
          afterEntered.resolve();
          await afterRelease.promise;
          return context.result;
        },
      },
    });
    const handler = executor.execute(toolCall('sealed-1', 'sealed'), undefined);
    const response = Promise.resolve(handler);
    await afterEntered.promise;

    const lateStop = handler.stop('late stop');
    expect(handler.detach('late detach')).toBeUndefined();
    expect(executionSignal?.aborted).toBe(false);
    expect(handler.snapshot().stopReason).toBeUndefined();

    afterRelease.resolve();
    expect(await lateStop).toMatchObject({
      content: textToolContent('raw'),
      outcome: { type: 'success' },
    });
    expect(isToolDetachAck(await response)).toBe(false);
  });

  // 来源：PR #3227 的 core 输出错误子集，固定 flush/close 错误、字段与 offset，不涉及 agent spill 管线。
  // https://github.com/MoonshotAI/kimi-code/pull/3227
  it('reads fields and output mid-run and surfaces flush and close errors', async () => {
    const started = deferred();
    const release = deferred();
    const logs = captureLogs();
    const store = memoryOutputStore();
    const outputStore = {
      open(taskId: string) {
        const output = store.open(taskId);
        return {
          append: (chunk: string) => output.append(chunk),
          preview: (maxBytes?: number) => output.preview(maxBytes),
          read: (offset: number, maxBytes: number) => output.read(offset, maxBytes),
          flush: async () => {
            await output.flush();
            throw new Error('flush failed');
          },
          close: async () => {
            await output.close();
            throw new Error('close failed');
          },
          error: () => output.error(),
        };
      },
    };
    const tool = defineTool('output-errors', {
      execute: async (context) => {
        expect(context.write('abc')).toBe(0);
        expect(context.write('def')).toBe(3);
        context.set({ status: 'working' });
        started.resolve();
        await release.promise;
        try {
          await context.flush();
        } catch (error) {
          context.set({ flushError: error instanceof Error ? error.message : String(error) });
        }
        return { content: textToolContent('done') };
      },
    });
    const handler = new ToolExecutor([tool], { outputStore }).execute(
      toolCall('output-errors-1', 'output-errors'),
      undefined,
    );
    const offsets: number[] = [];
    handler.observe((event) => {
      if (event.type === 'output') offsets.push(event.offset);
    });
    await started.promise;

    expect(handler.output()).toMatchObject({ totalBytes: 6, preview: 'abcdef' });
    expect(handler.fields()).toMatchObject({ status: 'working' });
    release.resolve();
    expect(await handler.wait()).toMatchObject({
      outcome: { type: 'failed', error: { type: 'output', data: 'close failed' } },
    });
    expect(handler.fields()).toMatchObject({ flushError: 'flush failed' });
    expect(handler.snapshot().outputError).toBe('close failed');
    expect(offsets).toEqual([0, 3]);
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'warn',
      context: expect.objectContaining({ type: 'tool.output_close_failed', reason: 'close failed' }),
    }));
  });

  // 来源：Issue #4241 的 core 结果子集，只固定 synthetic 短路和现有 outcome，不引入 agent 扩展枚举。
  // https://github.com/MoonshotAI/kimi-code/issues/4241
  it('returns a synthetic preparation result without executing the tool', async () => {
    const execute = vi.fn(() => ({ content: textToolContent('must not run') }));
    const afterExecute = vi.fn();
    const logs = captureLogs();
    const tool = defineTool('synthetic', {
      prepare: () => ({
        type: 'synthetic',
        prepared: { source: 'prepare' },
        result: { content: textToolContent('synthetic result') },
      }),
      execute,
    });
    const result = await new ToolExecutor([tool], {
      hook: { afterExecute },
    }).execute(toolCall('synthetic-1', 'synthetic'), undefined).wait();

    expect(result).toMatchObject({
      content: textToolContent('synthetic result'),
      outcome: { type: 'success' },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(afterExecute).toHaveBeenCalledTimes(1);
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'info',
      context: expect.objectContaining({ type: 'tool.synthetic', phase: 'resolve' }),
    }));
  });

  it('applies validating rewrites and stops validating rejections before prepare', async () => {
    const rewrittenExecute = vi.fn(() => ({ content: textToolContent('rewritten') }));
    const rewritten = new ToolExecutor([defineTool('validating-rewrite', {
      execute: rewrittenExecute,
    })], {
      hook: { validating: () => ({ args: { value: 2 } }) },
    });
    expect((await rewritten.execute(
      toolCall('validating-rewrite-1', 'validating-rewrite', { value: 1 }),
      undefined,
    ).wait()).outcome.type).toBe('success');
    expect(rewrittenExecute).toHaveBeenCalledWith(expect.objectContaining({ args: { value: 2 } }));

    const prepare = vi.fn(() => ({ type: 'execute' as const, prepared: {} }));
    const rejected = new ToolExecutor([defineTool('validating-reject', { prepare })], {
      hook: {
        validating: () => ({
          reject: 'invalid call',
          result: { content: textToolContent('validation rejection') },
        }),
      },
    });
    const result = await rejected.execute(
      toolCall('validating-reject-1', 'validating-reject'),
      undefined,
    ).wait();
    expect(result).toMatchObject({
      content: textToolContent('validation rejection'),
      outcome: { type: 'failed', error: { type: 'invalid', phase: 'validate' } },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects empty tool names during construction and registration', () => {
    expect(() => new ToolExecutor([defineTool(' ')])).toThrow('tool name must be a non-empty string');
    const executor = new ToolExecutor([]);
    expect(() => executor.addExecute(defineTool(''))).toThrow('tool name must be a non-empty string');
  });

  it('emits structured info and debug logs without raw args or output text', async () => {
    const logs = captureLogs();
    const tool = defineTool('logging', {
      execute: (context) => {
        context.write('secret output');
        return { content: textToolContent('done') };
      },
    });
    const executor = new ToolExecutor([tool], {
      hook: {
        starting: () => ({ args: { payload: 'rewritten-placeholder' } }),
      },
    });

    const result = await executor.execute(
      toolCall('logging-1', 'logging', { payload: 'raw-placeholder' }),
      undefined,
    ).wait();
    expect(result.outcome.type).toBe('success');
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'info',
      message: 'tool event',
      context: expect.objectContaining({
        type: 'tool.started',
        toolCallId: 'logging-1',
        name: 'logging',
        phase: 'resolve',
      }),
    }));
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'info',
      context: expect.objectContaining({ type: 'tool.execute', phase: 'execute' }),
    }));
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'info',
      context: expect.objectContaining({
        type: 'tool.ended',
        outcome: 'success',
        phase: 'after-execute',
        elapsedMs: expect.any(Number),
        executeElapsedMs: expect.any(Number),
      }),
    }));
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'debug',
      context: expect.objectContaining({ type: 'tool.phase', phase: 'parse', previousPhase: 'resolve' }),
    }));
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'debug',
      context: expect.objectContaining({ type: 'tool.args_rewritten', phase: 'starting' }),
    }));
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'debug',
      context: expect.objectContaining({ type: 'tool.output', offset: 0, characters: 13 }),
    }));
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('raw-placeholder');
    expect(serialized).not.toContain('rewritten-placeholder');
    expect(serialized).not.toContain('secret output');
  });

  it('logs policy rejection at info level and terminal failure at error level', async () => {
    const logs = captureLogs();
    const executor = new ToolExecutor([defineTool('logged-failure')], {
      hook: {
        permitting: () => ({
          reject: 'policy denied',
          result: { content: textToolContent('denied') },
        }),
      },
    });

    const result = await executor.execute(toolCall('logged-failure-1', 'logged-failure'), undefined).wait();
    expect(result.outcome.type).toBe('failed');
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'info',
      context: expect.objectContaining({
        type: 'tool.rejected',
        phase: 'permitting',
        reason: 'policy denied',
        synthetic: true,
      }),
    }));
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'error',
      message: 'tool execution failed',
      context: expect.objectContaining({
        type: 'tool.ended',
        outcome: 'failed',
        error: { type: 'rejected', phase: 'permitting', reason: 'policy denied' },
      }),
    }));
  });

  it('logs observer and abandon warnings without changing their outcomes', async () => {
    const logs = captureLogs();
    const observerExecutor = new ToolExecutor([defineTool('logged-observers')], {
      hook: {
        observe: () => {
          throw new Error('policy observer failed');
        },
      },
    });
    const observerHandler = observerExecutor.execute(
      toolCall('logged-observers-1', 'logged-observers'),
      undefined,
    );
    observerHandler.observe(() => {
      throw new Error('handler observer failed');
    });
    expect((await observerHandler.wait()).outcome.type).toBe('success');

    const started = deferred();
    const hangingExecutor = new ToolExecutor([defineTool('logged-abandon', {
      execute: async () => {
        started.resolve();
        return new Promise<never>(() => {});
      },
      stopping: (context) => {
        context.abandon({ content: textToolContent('abandoned') });
      },
    })]);
    const hangingHandler = hangingExecutor.execute(
      toolCall('logged-abandon-1', 'logged-abandon'),
      undefined,
    );
    await started.promise;
    const abandoned = await hangingHandler.stop('halt');
    expect(abandoned.outcome).toMatchObject({ type: 'aborted', error: { type: 'abandoned' } });

    const warnings = logs.filter((entry) => entry.level === 'warn');
    expect(warnings).toContainEqual(expect.objectContaining({
      context: expect.objectContaining({ type: 'tool.observer_failed', source: 'policy' }),
    }));
    expect(warnings).toContainEqual(expect.objectContaining({
      context: expect.objectContaining({ type: 'tool.observer_failed', source: 'handler' }),
    }));
    expect(warnings).toContainEqual(expect.objectContaining({
      context: expect.objectContaining({ type: 'tool.abandoned', toolCallId: 'logged-abandon-1' }),
    }));
  });

});

describe('As a tool author, I want to inspect and detach my live execution so that I can control long-running work', () => {
  it('exposes the live view through the tool execute context', async () => {
    const tool = defineTool('context-view', {
      prepare: () => ({ type: 'execute', prepared: { ready: true } }),
      execute: (context) => {
        expect(context.output()).toEqual({ totalBytes: 0, preview: '', truncated: false });
        context.set({ progress: 1 });
        expect(context.write('abc')).toBe(0);
        expect(context.fields()).toEqual({ progress: 1 });
        expect(context.output()).toMatchObject({ totalBytes: 3, preview: 'abc' });
        expect(context.snapshot()).toMatchObject({
          id: 'context-view-1',
          status: 'running',
          phase: 'execute',
          args: { value: 1 },
          prepared: { ready: true },
          fields: { progress: 1 },
        });
        return { content: textToolContent('done') };
      },
    });
    const handler = new ToolExecutor([tool]).execute(
      toolCall('context-view-1', 'context-view', { value: 1 }),
      undefined,
    );

    expect((await handler.wait()).outcome.type).toBe('success');
    expect(handler.fields()).toEqual({ progress: 1 });
    expect(handler.output()).toMatchObject({ totalBytes: 3, preview: 'abc' });
  });

  it('detaches from inside execute while wait continues to the final result', async () => {
    const started = deferred();
    const release = deferred();
    let ack: ToolDetachAck | undefined;
    const tool = defineTool('context-detach', {
      execute: async (context) => {
        ack = context.detach('later');
        started.resolve();
        await release.promise;
        return { content: textToolContent('finished') };
      },
    });
    const handler = new ToolExecutor([tool]).execute(
      toolCall('context-detach-1', 'context-detach'),
      undefined,
    );
    const response = Promise.resolve(handler);
    await started.promise;

    expect(ack).toMatchObject({
      detached: true,
      taskId: handler.taskId,
      toolCallId: 'context-detach-1',
    });
    await expect(response).resolves.toBe(ack);
    release.resolve();
    expect(await handler.wait()).toMatchObject({
      content: textToolContent('finished'),
      outcome: { type: 'success' },
    });
  });

});

describe('As a runtime caller, I want validation and preparation failures to be distinguishable so that I can diagnose rejected calls', () => {
  it('maps schema validation failures to an invalid validate outcome', async () => {
    const prepare = vi.fn(() => ({ type: 'execute' as const, prepared: {} }));
    const execute = vi.fn(() => ({ content: textToolContent('must not run') }));
    const tool = defineTool('invalid-args', {
      parameters: {
        type: 'object',
        properties: { value: { type: 'integer' } },
        required: ['value'],
        additionalProperties: false,
      },
      prepare,
      execute,
    });

    const result = await new ToolExecutor([tool]).execute(
      toolCall('invalid-args-1', 'invalid-args', { value: 'wrong' }),
      undefined,
    ).wait();
    expect(result.outcome).toMatchObject({
      type: 'failed',
      error: { type: 'invalid', phase: 'validate' },
    });
    expect(result.outcome.type === 'failed' && result.outcome.error.reason).toContain('must be integer');
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps prepare exceptions to resolve failures without executing', async () => {
    const execute = vi.fn(() => ({ content: textToolContent('must not run') }));
    const tool = defineTool('prepare-error', {
      prepare: () => {
        throw new Error('prepare failed');
      },
      execute,
    });

    const result = await new ToolExecutor([tool]).execute(
      toolCall('prepare-error-1', 'prepare-error'),
      undefined,
    ).wait();
    expect(result.outcome).toMatchObject({
      type: 'failed',
      error: {
        type: 'resolve',
        phase: 'resolve',
        reason: 'Tool "prepare-error" failed to resolve execution: prepare failed',
      },
    });
    expect(execute).not.toHaveBeenCalled();
  });

});

describe('As a handler caller, I want conditional waits to settle independently so that waiting does not change execution', () => {
  it('resolves a conditioned wait when completion wins before the timeout', async () => {
    const started = deferred();
    const release = deferred();
    const tool = defineTool('conditioned-wait', {
      execute: async () => {
        started.resolve();
        await release.promise;
        return { content: textToolContent('finished') };
      },
    });
    const handler = new ToolExecutor([tool]).execute(
      toolCall('conditioned-wait-1', 'conditioned-wait'),
      undefined,
    );
    await started.promise;

    const waiting = handler.wait(1000);
    release.resolve();
    await expect(waiting).resolves.toMatchObject({
      content: textToolContent('finished'),
      outcome: { type: 'success' },
    });
  });

  it('propagates completion rejection through a conditioned wait', async () => {
    const failure = new Error('starting failed');
    const executor = new ToolExecutor([defineTool('conditioned-rejection')], {
      hook: {
        starting: () => {
          throw failure;
        },
      },
    });
    const handler = executor.execute(
      toolCall('conditioned-rejection-1', 'conditioned-rejection'),
      undefined,
    );
    const response = Promise.resolve(handler);

    await expect(handler.wait(1000)).rejects.toBe(failure);
    await expect(response).rejects.toBe(failure);
  });

  it('returns the settled completion even with wait options', async () => {
    const handler = new ToolExecutor([defineTool('settled-wait')]).execute(
      toolCall('settled-wait-1', 'settled-wait'),
      undefined,
    );
    const result = await handler.wait();

    await expect(handler.wait(0)).resolves.toBe(result);
  });

  it('rejects an already-aborted wait without stopping execution', async () => {
    const started = deferred();
    const release = deferred();
    const tool = defineTool('pre-aborted-wait', {
      execute: async () => {
        started.resolve();
        await release.promise;
        return { content: textToolContent('finished') };
      },
    });
    const handler = new ToolExecutor([tool]).execute(
      toolCall('pre-aborted-wait-1', 'pre-aborted-wait'),
      undefined,
    );
    await started.promise;
    const controller = new AbortController();
    const reason = new Error('stop waiting only');
    controller.abort(reason);

    await expect(handler.wait(undefined, controller.signal)).rejects.toBe(reason);
    expect(handler.snapshot().status).toBe('running');
    release.resolve();
    expect((await handler.wait()).outcome.type).toBe('success');
  });

});

describe('As a runtime caller, I want lifecycle hook failures to preserve truthful terminal outcomes so that cancellation and failure remain distinguishable', () => {
  it('maps afterExecute exceptions to failed results', async () => {
    const execute = vi.fn(() => ({ content: textToolContent('raw') }));
    const executor = new ToolExecutor([defineTool('after-error', { execute })], {
      hook: {
        afterExecute: () => {
          throw new Error('after failed');
        },
      },
    });

    const result = await executor.execute(toolCall('after-error-1', 'after-error'), undefined).wait();
    expect(result.outcome).toMatchObject({
      type: 'failed',
      error: {
        type: 'unknown',
        phase: 'after-execute',
        reason: 'after-execute hook failed for "after-error": after failed',
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('preserves the aborted outcome when afterExecute throws', async () => {
    const started = deferred();
    const tool = defineTool('after-aborted-error', {
      execute: async (context) => {
        started.resolve();
        return new Promise((resolve) => {
          context.signal.addEventListener('abort', () => {
            resolve({ content: textToolContent('stopped') });
          }, { once: true });
        });
      },
    });
    const executor = new ToolExecutor([tool], {
      hook: {
        afterExecute: () => {
          throw new Error('after failed');
        },
      },
    });
    const handler = executor.execute(
      toolCall('after-aborted-error-1', 'after-aborted-error'),
      undefined,
    );
    await started.promise;

    const result = await handler.stop('cancel');
    expect(result).toMatchObject({
      toolCallId: 'after-aborted-error-1',
      outcome: {
        type: 'aborted',
        error: { type: 'stopped', phase: 'execute', reason: 'cancel' },
      },
    });
  });

  it('stops while a decision is pending and notifies late-bound stopping once', async () => {
    const started = deferred();
    const release = deferred();
    const stopping = vi.fn();
    const execute = vi.fn(() => ({ content: textToolContent('must not run') }));
    const tool = defineTool('pending-stop', { stopping, execute });
    const executor = new ToolExecutor([tool], {
      hook: {
        starting: () => {
          started.resolve();
          return release.promise;
        },
      },
    });
    const handler = executor.execute(toolCall('pending-stop-1', 'pending-stop'), undefined);
    await started.promise;

    const stopped = handler.stop('cancel');
    release.resolve();
    expect(await stopped).toMatchObject({
      outcome: { type: 'aborted', error: { type: 'stopped', reason: 'cancel' } },
    });
    expect(stopping).toHaveBeenCalledTimes(1);
    expect(stopping).toHaveBeenCalledWith(expect.objectContaining({ reason: 'cancel' }));
    expect(execute).not.toHaveBeenCalled();
  });

  it('logs active stopping failures and still settles after abort', async () => {
    const started = deferred();
    const logs = captureLogs();
    const tool = defineTool('active-stopping-error', {
      execute: async (context) => {
        started.resolve();
        return new Promise((resolve) => {
          context.signal.addEventListener('abort', () => {
            resolve({ content: textToolContent('stopped') });
          }, { once: true });
        });
      },
      stopping: () => {
        throw new Error('stopping failed');
      },
    });
    const handler = new ToolExecutor([tool]).execute(
      toolCall('active-stopping-error-1', 'active-stopping-error'),
      undefined,
    );
    await started.promise;

    const result = await handler.stop('halt');
    expect(result.outcome).toMatchObject({ type: 'aborted', error: { type: 'stopped', reason: 'halt' } });
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'warn',
      context: expect.objectContaining({
        type: 'tool.stopping_failed',
        toolCallId: 'active-stopping-error-1',
        reason: 'stopping failed',
      }),
    }));
  });

  it('logs late-bound stopping failures without replacing the aborted outcome', async () => {
    const started = deferred();
    const release = deferred();
    const logs = captureLogs();
    const execute = vi.fn(() => ({ content: textToolContent('must not run') }));
    const tool = defineTool('late-stopping-error', {
      execute,
      stopping: () => {
        throw new Error('stopping failed');
      },
    });
    const executor = new ToolExecutor([tool], {
      hook: {
        starting: () => {
          started.resolve();
          return release.promise;
        },
      },
    });
    const handler = executor.execute(
      toolCall('late-stopping-error-1', 'late-stopping-error'),
      undefined,
    );
    await started.promise;

    const stopped = handler.stop('halt');
    release.resolve();
    expect((await stopped).outcome).toMatchObject({
      type: 'aborted',
      error: { type: 'stopped', reason: 'halt' },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(logs).toContainEqual(expect.objectContaining({
      level: 'warn',
      context: expect.objectContaining({
        type: 'tool.stopping_failed',
        toolCallId: 'late-stopping-error-1',
        reason: 'stopping failed',
      }),
    }));
  });

  it('uses default aborted content when abandon has no result', async () => {
    const started = deferred();
    const tool = defineTool('default-abandon', {
      execute: async () => {
        started.resolve();
        return new Promise<never>(() => {});
      },
      stopping: (context) => {
        context.abandon();
      },
    });
    const handler = new ToolExecutor([tool]).execute(
      toolCall('default-abandon-1', 'default-abandon'),
      undefined,
    );
    await started.promise;

    expect(await handler.stop('halt')).toMatchObject({
      content: textToolContent('halt'),
      outcome: { type: 'aborted', error: { type: 'abandoned', reason: 'halt' } },
    });
  });

  it('ignores onDetach registration after execution settles', async () => {
    const acknowledge = vi.fn(() => ({ content: textToolContent('late ack') }));
    let lateRegister: (() => void) | undefined;
    const tool = defineTool('late-detach-registration', {
      execute: (context) => {
        lateRegister = () => context.onDetach(acknowledge);
        return { content: textToolContent('done') };
      },
    });
    const handler = new ToolExecutor([tool]).execute(
      toolCall('late-detach-registration-1', 'late-detach-registration'),
      undefined,
    );

    expect((await handler.wait()).outcome.type).toBe('success');
    lateRegister?.();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(handler.detach('late')).toBeUndefined();
  });

});

describe('As a policy author, I want rewritten arguments to be prepared again so that updated inputs can produce synthetic results without execution', () => {
  it('returns a synthetic result when starting-rewrite reprepare short-circuits', async () => {
    let preparations = 0;
    const execute = vi.fn(() => ({ content: textToolContent('must not run') }));
    const permitting = vi.fn();
    const tool = defineTool('starting-reprepare-synthetic', {
      prepare: () => {
        preparations += 1;
        if (preparations === 1) return { type: 'execute' as const, prepared: { attempt: 1 } };
        return {
          type: 'synthetic' as const,
          prepared: { attempt: 2 },
          result: { content: textToolContent('starting synthetic') },
        };
      },
      execute,
    });
    const executor = new ToolExecutor([tool], {
      hook: {
        starting: () => ({ args: { rewritten: true }, skipPermitting: true }),
        permitting,
      },
    });

    const result = await executor.execute(
      toolCall('starting-reprepare-synthetic-1', 'starting-reprepare-synthetic'),
      undefined,
    ).wait();
    expect(result).toMatchObject({
      content: textToolContent('starting synthetic'),
      outcome: { type: 'success' },
    });
    expect(preparations).toBe(2);
    expect(permitting).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns a synthetic result when permitting-rewrite reprepare short-circuits', async () => {
    let preparations = 0;
    const execute = vi.fn(() => ({ content: textToolContent('must not run') }));
    const beforeExecute = vi.fn();
    const tool = defineTool('permitting-reprepare-synthetic', {
      prepare: () => {
        preparations += 1;
        if (preparations === 1) return { type: 'execute' as const, prepared: { attempt: 1 } };
        return {
          type: 'synthetic' as const,
          prepared: { attempt: 2 },
          result: { content: textToolContent('permitting synthetic') },
        };
      },
      execute,
    });
    const executor = new ToolExecutor([tool], {
      hook: {
        permitting: () => ({ args: { rewritten: true } }),
        beforeExecute,
      },
    });

    const result = await executor.execute(
      toolCall('permitting-reprepare-synthetic-1', 'permitting-reprepare-synthetic'),
      undefined,
    ).wait();
    expect(result).toMatchObject({
      content: textToolContent('permitting synthetic'),
      outcome: { type: 'success' },
    });
    expect(preparations).toBe(2);
    expect(beforeExecute).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

});

describe('As a handler caller, I want subscriptions and settled executions to reject late side effects so that completed work remains stable', () => {
  it('stops delivering handler events after unsubscribe', async () => {
    const events: string[] = [];
    const handler = new ToolExecutor([defineTool('unsubscribed-observer')]).execute(
      toolCall('unsubscribed-observer-1', 'unsubscribed-observer'),
      undefined,
    );
    const unsubscribe = handler.observe((event) => {
      events.push(event.type);
    });
    unsubscribe();

    expect((await handler.wait()).outcome.type).toBe('success');
    expect(events).toEqual([]);
  });

  it('ignores empty and late writes and late fields after execution settles', async () => {
    let write: ((text: string) => number | undefined) | undefined;
    let set: ((fields: object) => void) | undefined;
    const tool = defineTool('frozen-output-fields', {
      execute: (context) => {
        write = context.write;
        set = context.set;
        expect(context.write('')).toBeUndefined();
        context.set({ progress: 1 });
        expect(context.write('saved')).toBe(0);
        return { content: textToolContent('done') };
      },
    });
    const handler = new ToolExecutor([tool]).execute(
      toolCall('frozen-output-fields-1', 'frozen-output-fields'),
      undefined,
    );

    expect((await handler.wait()).outcome.type).toBe('success');
    expect(write).toBeTypeOf('function');
    expect(set).toBeTypeOf('function');
    expect(write?.('late')).toBeUndefined();
    set?.({ progress: 2 });
    expect(handler.fields()).toEqual({ progress: 1 });
    expect(handler.output()).toMatchObject({ totalBytes: 5, preview: 'saved' });
  });
});
