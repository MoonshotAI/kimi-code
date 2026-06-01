/**
 * `registerAgentTask` `timeoutMs` option.
 *
 * Semantics:
 *   - external deadline fires → status=`failed`, `stopReason="Timed out"`
 *   - no `timeoutMs` → the task runs to completion without a wrapper
 *   - internal `TimeoutError` rejection (e.g. aiohttp sock_read) is a
 *     generic `failed` with no stop reason — the timeout reason must
 *     only be set for the caller-driven deadline
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundProcessManager } from '../../../src/tools/background/manager';
import { BACKGROUND_TASK_TIMEOUT_STOP_REASON } from '../../../src/tools/background/task';

describe('BackgroundProcessManager.registerAgentTask — timeoutMs', () => {
  const manager = new BackgroundProcessManager();

  afterEach(() => {
    manager._reset();
    vi.useRealTimers();
  });

  it('external deadline marks task failed with a timeout stop reason', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // A never-resolving completion — only the deadline will fire.
    const hangForever = new Promise<{ result: string }>(() => {});
    const taskId = manager.registerAgentTask(hangForever, 'hang', { timeoutMs: 2_000 });

    // Advance past the deadline; awaitTerminal resolves once the race
    // finishes and the `.finally` block runs.
    const terminalPromise = manager.waitForTerminal(taskId);
    await vi.advanceTimersByTimeAsync(2_100);
    const info = await terminalPromise;

    expect(info?.status).toBe('failed');
    expect(info?.stopReason).toBe(BACKGROUND_TASK_TIMEOUT_STOP_REASON);
  });

  it('omitting timeoutMs lets the task run to completion (no wrapper)', async () => {
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });
    const taskId = manager.registerAgentTask(completion, 'no deadline');

    resolveFn({ result: 'finished' });
    const info = await manager.waitForTerminal(taskId);
    expect(info?.status).toBe('completed');
    expect(info?.stopReason).toBeUndefined();
  });

  it('internal TimeoutError rejection = generic failure, stop reason unset', async () => {
    // Even with a deadline set, an internal TimeoutError that fires
    // BEFORE the deadline must land as a plain `failed` (not as a
    // deadline-driven timeout).
    const internalErr = new Error('aiohttp sock_read timeout');
    internalErr.name = 'TimeoutError';
    const rejecting = Promise.reject(internalErr);
    const taskId = manager.registerAgentTask(rejecting, 'internal timeout', {
      timeoutMs: 900_000,
    });

    const info = await manager.waitForTerminal(taskId);
    expect(info?.status).toBe('failed');
    // Deadline never fired → timeout stop reason must NOT be set.
    expect(info?.stopReason).toBeUndefined();
  });

  // Explicit per-task timeoutMs must be surfaced on the task info so
  // downstream wait-cap consumers can honour the agent-supplied value
  // instead of falling back to a hard-coded default. (gap #6 family.)
  //
  // Uses fake timers so the 30-min deadline armed by registerAgentTask
  // does not leak across the test boundary into the Vitest worker —
  // the `completion` promise here never resolves, so the lifecycle
  // promise's `.finally(clearTimeout)` would not run under real time.
  it('explicit timeoutMs is persisted on the task info', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const taskId = manager.registerAgentTask(new Promise(() => {}), 'persist timeout', {
      timeoutMs: 1_800_000,
    });
    const info = manager.getTask(taskId);
    expect((info as unknown as { timeoutMs?: number }).timeoutMs).toBe(1_800_000);
  });

  // Decision (confirmed with team, 2026-05-19): background tasks in
  // kimi-code do NOT carry an implicit default timeout. The Python
  // kimi-cli enforced a 30-min default because its agents were
  // expected to be short-lived; kimi-code's agents may legitimately
  // run a dev server, a long compile, or a watch loop, and an
  // auto-kill would be a footgun. The shutdown wait-cap that reads
  // timeoutMs falls back to its own policy when the field is
  // undefined; the BPM does not invent a default.
  //
  // This test is kept (rather than deleted) to act as a regression
  // guard: if someone later adds a hard-coded default in
  // registerAgentTask, the assertion below catches it.
  it('omitted timeoutMs leaves the task info field undefined', () => {
    const taskId = manager.registerAgentTask(new Promise(() => {}), 'default timeout');
    const info = manager.getTask(taskId);
    expect((info as unknown as { timeoutMs?: number }).timeoutMs).toBeUndefined();
  });

  // Contract decision (2026-05-21): kimi-code treats `timeoutMs: 0`
  // as "record the value but do NOT arm a deadline" rather than
  // Python's "fire immediately" semantics. The field is preserved on
  // the task info so shutdown wait-caps / UI can read it; the
  // deadline-arming check (`opts.timeoutMs > 0`) deliberately skips
  // zero so a caller writing `0` does not lose its task to an
  // immediate kill.
  it('timeoutMs=0 is preserved on the task info and does not arm a deadline', async () => {
    const taskId = manager.registerAgentTask(new Promise(() => {}), 'zero timeout', {
      timeoutMs: 0,
    });
    // The literal zero is preserved on the task info.
    const initial = manager.getTask(taskId);
    expect((initial as unknown as { timeoutMs?: number }).timeoutMs).toBe(0);

    // No deadline armed: the task stays running. We bound the wait
    // with a short race so the test does not hang on the never-
    // settling completion promise; the racing branch winning is the
    // expected outcome.
    const raced = await Promise.race<{ status: string; stopReason?: string } | undefined>([
      manager.waitForTerminal(taskId).then((info) =>
        info === undefined ? undefined : { status: info.status, stopReason: info.stopReason },
      ),
      new Promise<{ status: string; stopReason?: string }>((res) => {
        setTimeout(() => {
          res({ status: 'running' });
        }, 100);
      }),
    ]);
    expect(raced?.status).toBe('running');
    expect(raced?.stopReason).toBeUndefined();
  });
});
