import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Writable } from 'node:stream';

import { drainStdio, finalizeHeadlessRun, scheduleHeadlessForceExit } from '#/cli/headless-exit';

describe('scheduleHeadlessForceExit', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('force-exits with the lazily-resolved exit code after the grace period', () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    let code = 0;
    const handle = scheduleHeadlessForceExit({ exit }, () => code, 2000);
    // The exit code can be set after scheduling (e.g. a goal turn maps its
    // terminal status to process.exitCode); it must be read at fire time.
    code = 7;

    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(7);

    clearTimeout(handle);
  });

  it('schedules an unref\'d timer so a healthy run still exits naturally', () => {
    // Real timers: an un-unref'd guard would itself keep the event loop alive,
    // turning the fix into a regression (every healthy run would wait the full
    // grace before exiting). hasRef() must be false.
    const exit = vi.fn();
    const handle = scheduleHeadlessForceExit({ exit }, () => 0, 60_000);
    expect((handle as { hasRef?: () => boolean }).hasRef?.()).toBe(false);
    clearTimeout(handle);
  });

  it('does not fire once cancelled via clearTimeout', () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const handle = scheduleHeadlessForceExit({ exit }, () => 0, 2000);
    clearTimeout(handle);
    vi.advanceTimersByTime(5000);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('drainStdio', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves once buffered output has flushed', async () => {
    let flush: (() => void) | undefined;
    const stream = {
      write: vi.fn((_chunk: string, cb: () => void) => {
        flush = cb;
        return false;
      }),
    } as unknown as Writable;

    let resolved = false;
    const done = drainStdio([stream], 5000).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false); // still draining

    flush?.(); // consumer caught up
    await done;
    expect(resolved).toBe(true);
  });

  it('gives up after the timeout when the consumer never drains', async () => {
    vi.useFakeTimers();
    // write() never invokes its flush callback — a permanently-stuck consumer.
    const stream = { write: vi.fn(() => false) } as unknown as Writable;

    let resolved = false;
    const done = drainStdio([stream], 3000).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(resolved).toBe(true);
  });
});

describe('finalizeHeadlessRun', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes stdio before arming the force-exit so buffered output is not truncated', async () => {
    vi.useFakeTimers();
    let flush: (() => void) | undefined;
    const stream = {
      write: vi.fn((_chunk: string, cb: () => void) => {
        flush = cb;
        return false;
      }),
    } as unknown as Writable;
    const exit = vi.fn();

    const done = finalizeHeadlessRun({ exit }, [stream], () => 0, {
      drainTimeoutMs: 5000,
      graceMs: 2000,
    });

    // Output is still draining: even well past the force-exit grace, we must NOT
    // have armed/fired the exit — doing so would truncate the buffered output.
    await vi.advanceTimersByTimeAsync(4000);
    expect(exit).not.toHaveBeenCalled();

    // Consumer catches up → drain completes → only now is the backstop armed.
    flush?.();
    await done;
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
