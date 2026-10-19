import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStreamIdleWatchdog } from '#/llm/requester/streamIdleWatchdog';
import {
  LLM_STREAM_IDLE_TIMEOUT_ENV,
  resolveLlmStreamIdleTimeoutMs,
} from '#/llm/requester/timeout';

describe('resolveLlmStreamIdleTimeoutMs', () => {
  it('defaults to 90s when the env var is unset or empty', () => {
    expect(resolveLlmStreamIdleTimeoutMs({})).toBe(90_000);
    expect(resolveLlmStreamIdleTimeoutMs({ [LLM_STREAM_IDLE_TIMEOUT_ENV]: '  ' })).toBe(90_000);
  });

  it('honors a millisecond override', () => {
    expect(resolveLlmStreamIdleTimeoutMs({ [LLM_STREAM_IDLE_TIMEOUT_ENV]: '5000' })).toBe(5_000);
  });

  it('treats 0 as disabled', () => {
    expect(resolveLlmStreamIdleTimeoutMs({ [LLM_STREAM_IDLE_TIMEOUT_ENV]: '0' })).toBeUndefined();
  });

  it('treats "off" as disabled', () => {
    expect(resolveLlmStreamIdleTimeoutMs({ [LLM_STREAM_IDLE_TIMEOUT_ENV]: 'off' })).toBeUndefined();
    expect(
      resolveLlmStreamIdleTimeoutMs({ [LLM_STREAM_IDLE_TIMEOUT_ENV]: ' Off ' }),
    ).toBeUndefined();
  });

  it('rejects invalid values naming the env var', () => {
    for (const raw of ['abc', '-1', '1.5', '3000000000']) {
      expect(() =>
        resolveLlmStreamIdleTimeoutMs({ [LLM_STREAM_IDLE_TIMEOUT_ENV]: raw }),
      ).toThrowError(LLM_STREAM_IDLE_TIMEOUT_ENV);
    }
  });
});

describe('createStreamIdleWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts its signal and reports once after the idle threshold', async () => {
    const onIdle = vi.fn();
    const watchdog = createStreamIdleWatchdog({
      idleTimeoutMs: 1_000,
      upstream: new AbortController().signal,
      onIdle,
    });
    expect(watchdog.triggered).toBe(false);

    await vi.advanceTimersByTimeAsync(999);
    expect(onIdle).not.toHaveBeenCalled();
    expect(watchdog.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(watchdog.triggered).toBe(true);
    expect(watchdog.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stays quiet while reset keeps arriving within the threshold', async () => {
    const onIdle = vi.fn();
    const watchdog = createStreamIdleWatchdog({
      idleTimeoutMs: 1_000,
      upstream: new AbortController().signal,
      onIdle,
    });

    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(900);
      watchdog.reset();
    }
    expect(onIdle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('never fires after cancel and leaves no timers behind', async () => {
    const onIdle = vi.fn();
    const watchdog = createStreamIdleWatchdog({
      idleTimeoutMs: 1_000,
      upstream: new AbortController().signal,
      onIdle,
    });

    watchdog.cancel();
    watchdog.cancel();
    watchdog.reset();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onIdle).not.toHaveBeenCalled();
    expect(watchdog.triggered).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('relays an upstream abort with its reason without tripping', async () => {
    const upstream = new AbortController();
    const onIdle = vi.fn();
    const watchdog = createStreamIdleWatchdog({
      idleTimeoutMs: 1_000,
      upstream: upstream.signal,
      onIdle,
    });

    const reason = new Error('user cancel');
    upstream.abort(reason);
    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.signal.reason).toBe(reason);
    expect(watchdog.triggered).toBe(false);

    watchdog.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('starts aborted when the upstream is already aborted', () => {
    const upstream = new AbortController();
    upstream.abort();
    const watchdog = createStreamIdleWatchdog({
      idleTimeoutMs: 1_000,
      upstream: upstream.signal,
      onIdle: vi.fn(),
    });
    expect(watchdog.signal.aborted).toBe(true);
    watchdog.cancel();
  });
});
