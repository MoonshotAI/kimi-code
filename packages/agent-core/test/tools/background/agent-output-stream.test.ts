/**
 * `registerAgentTask` `outputSource` streaming.
 *
 * A background subagent is Promise-based, so without an output source the
 * task's output stays empty until completion. `outputSource` lets the
 * manager stream the subagent's formatted progress into the ring buffer /
 * output.log while it runs, mirroring how `register()` pipes a bash task's
 * stdout.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundProcessManager } from '../../../src/tools/background/manager';

describe('BackgroundProcessManager.registerAgentTask — outputSource', () => {
  const manager = new BackgroundProcessManager();

  afterEach(() => {
    manager._reset();
    vi.useRealTimers();
  });

  it('streams chunks into the task output before completion', async () => {
    let emit!: (chunk: string) => void;
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });

    const taskId = manager.registerAgentTask(completion, 'streaming', {
      outputSource: (onChunk) => {
        emit = onChunk;
        return () => {};
      },
    });

    emit('hello ');
    emit('world');
    // Visible mid-run, before the completion promise settles.
    expect(manager.getOutput(taskId)).toBe('hello world');

    resolveFn({ result: 'world' });
    await manager.waitForTerminal(taskId);

    // The streamed prose already ends with the final message, so the result is
    // not re-appended — the log is exactly what streamed, no duplication.
    expect(manager.getOutput(taskId)).toBe('hello world');
  });

  it('appends the result as the whole log when not streaming', async () => {
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });
    const taskId = manager.registerAgentTask(completion, 'raw');

    resolveFn({ result: 'just the summary' });
    await manager.waitForTerminal(taskId);

    // No outputSource → the result is the task's only output.
    expect(manager.getOutput(taskId)).toBe('just the summary');
  });

  it('falls back to the result when streaming produced no output', async () => {
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });
    // Subscribes but never emits a chunk.
    const taskId = manager.registerAgentTask(completion, 'silent', {
      outputSource: () => () => {},
    });

    resolveFn({ result: 'only the summary' });
    await manager.waitForTerminal(taskId);

    // Nothing streamed → the result is appended so the log is not empty.
    expect(manager.getOutput(taskId)).toBe('only the summary');
  });

  it('unsubscribes the output source when the task completes', async () => {
    let unsubscribed = false;
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });

    const taskId = manager.registerAgentTask(completion, 'unsub', {
      outputSource: () => () => {
        unsubscribed = true;
      },
    });

    resolveFn({ result: 'done' });
    // Cleanup runs inside finalizeTerminal, before waiters resolve, so it has
    // already fired by the time waitForTerminal returns — no drain needed.
    await manager.waitForTerminal(taskId);
    expect(unsubscribed).toBe(true);
  });

  it('unsubscribes the output source when the task is stopped (killed)', async () => {
    let unsubscribed = false;
    let rejectFn!: (error: unknown) => void;
    const completion = new Promise<{ result: string }>((_res, rej) => {
      rejectFn = rej;
    });

    const taskId = manager.registerAgentTask(completion, 'kill', {
      // stop() → proc.kill() → abort(); reject as an AbortError so the task is
      // recorded as killed (not failed), matching the real subagent abort path.
      abort: () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        rejectFn(error);
      },
      outputSource: () => () => {
        unsubscribed = true;
      },
    });

    const info = await manager.stop(taskId, 'test stop');
    expect(info?.status).toBe('killed');
    expect(unsubscribed).toBe(true);
  });

  it('unsubscribes the output source on the timeout path', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let unsubscribed = false;

    const taskId = manager.registerAgentTask(new Promise<{ result: string }>(() => {}), 'timeout', {
      timeoutMs: 2_000,
      outputSource: () => () => {
        unsubscribed = true;
      },
    });

    const terminal = manager.waitForTerminal(taskId);
    await vi.advanceTimersByTimeAsync(2_100);
    const info = await terminal;

    expect(info?.status).toBe('failed');
    expect(info?.timedOut).toBe(true);
    expect(unsubscribed).toBe(true);
  });

  it('drops chunks that arrive after the task is terminal', async () => {
    let emit!: (chunk: string) => void;
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });

    const taskId = manager.registerAgentTask(completion, 'late', {
      outputSource: (onChunk) => {
        emit = onChunk;
        return () => {};
      },
    });

    resolveFn({ result: 'R' });
    await manager.waitForTerminal(taskId);

    const before = manager.getOutput(taskId);
    emit('late chunk'); // guarded out — task is already terminal
    expect(manager.getOutput(taskId)).toBe(before);
  });
});
