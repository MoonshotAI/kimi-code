/**
 * BackgroundManager task timeout using AgentBackgroundTask metadata.
 *
 * Semantics:
 *   - manager-owned deadline fires → status=`timed_out`
 *   - no `timeoutMs` → the task runs to completion without a manager deadline
 *   - internal `TimeoutError` rejection (e.g. aiohttp sock_read) is a
 *     generic `failed` with no stop reason — the timeout reason must
 *     only be set for the caller-driven deadline
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentTask, createBackgroundManager } from './helpers';

describe('AgentBackgroundTask — timeoutMs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('external deadline marks task timed_out', async () => {
    const { manager } = createBackgroundManager();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // A never-resolving completion — only the deadline will fire.
    const hangForever = new Promise<{ result: string }>(() => {});
    const taskId = manager.registerTask(agentTask(hangForever, 'hang'), { timeoutMs: 2_000 });

    // Advance past the deadline and manager-owned stop grace.
    const terminalPromise = manager.wait(taskId);
    await vi.advanceTimersByTimeAsync(7_100);
    const info = await terminalPromise;

    expect(info?.status).toBe('timed_out');
    expect(info?.stopReason).toBeUndefined();
  });

  it('omitting timeoutMs lets the task run to completion without a manager deadline', async () => {
    const { manager } = createBackgroundManager();
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });
    const taskId = manager.registerTask(agentTask(completion, 'no deadline'));

    resolveFn({ result: 'finished' });
    const info = await manager.wait(taskId);
    expect(info?.status).toBe('completed');
    expect(info?.stopReason).toBeUndefined();
  });

  it('internal TimeoutError rejection = generic failure with error reason', async () => {
    const { manager } = createBackgroundManager();
    // Even with a deadline set, an internal TimeoutError that fires
    // BEFORE the deadline must land as a plain `failed` (not as a
    // deadline-driven timeout).
    const internalErr = new Error('aiohttp sock_read timeout');
    internalErr.name = 'TimeoutError';
    const rejecting = Promise.reject(internalErr);
    const taskId = manager.registerTask(agentTask(rejecting, 'internal timeout'), {
      timeoutMs: 900_000,
    });

    const info = await manager.wait(taskId);
    expect(info?.status).toBe('failed');
    // Deadline never fired: this is a normal task failure, so the original
    // error is preserved as the stop reason rather than being reported as a
    // caller-driven timeout.
    expect(info?.stopReason).toBe('aiohttp sock_read timeout');
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
    const { manager } = createBackgroundManager();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const taskId = manager.registerTask(agentTask(new Promise(() => {}), 'persist timeout'), {
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
    const { manager } = createBackgroundManager();
    const taskId = manager.registerTask(agentTask(new Promise(() => {}), 'default timeout'));
    const info = manager.getTask(taskId);
    expect((info as unknown as { timeoutMs?: number }).timeoutMs).toBeUndefined();
  });

  // Contract decision (2026-05-21): kimi-code treats `timeoutMs: 0`
  // as "record the value but do NOT arm a deadline" rather than
  // Python's "fire immediately" semantics. The field is preserved on
  // the task info so shutdown wait-caps / UI can read it; the
  // deadline-arming check (`timeoutMs > 0`) deliberately skips
  // zero so a caller writing `0` does not lose its task to an
  // immediate kill.
  it('timeoutMs=0 is preserved on the task info and does not arm a deadline', async () => {
    const { manager } = createBackgroundManager();
    const taskId = manager.registerTask(agentTask(new Promise(() => {}), 'zero timeout'), {
      timeoutMs: 0,
    });
    // The literal zero is preserved on the task info.
    const initial = manager.getTask(taskId);
    expect((initial as unknown as { timeoutMs?: number }).timeoutMs).toBe(0);

    // No deadline armed: the task stays running. We bound the wait
    // with a short race so the test does not hang on the never-
    // settling completion promise; the racing branch winning is the
    // expected outcome.
    const info = await manager.wait(taskId, 5);
    const raced = info === undefined ? undefined : {
      status: info.status,
      stopReason: info.stopReason,
    };
    expect(raced?.status).toBe('running');
    expect(raced?.stopReason).toBeUndefined();
  });
});
