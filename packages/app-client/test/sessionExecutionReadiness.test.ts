import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import {
  waitForSessionExecution,
  type SessionExecutionState,
} from '../src/lib/sessionExecutionReadiness';

afterEach(() => vi.useRealTimers());

function harness(initial: SessionExecutionState, turnActive: boolean) {
  const state = ref<SessionExecutionState>(initial);
  const active = ref(turnActive);
  const wait = (timeoutMs = 3000) =>
    waitForSessionExecution({
      read: () => state.value,
      turnActive: () => active.value,
      timeoutMs,
    });
  return { state, active, wait };
}

function track(promise: Promise<SessionExecutionState>) {
  const settled = { done: false, value: undefined as SessionExecutionState | undefined };
  void promise.then((value) => {
    settled.done = true;
    settled.value = value;
  });
  return settled;
}

describe('waitForSessionExecution', () => {
  it('resolves immediately while a turn is already running in the transcript', async () => {
    vi.useFakeTimers();
    const { wait } = harness({ turnId: 't2', status: 'running' }, true);
    await expect(wait()).resolves.toEqual({ turnId: 't2', status: 'running' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for the turn operation when the session reports an active main turn', async () => {
    const { state, wait } = harness({ turnId: null, status: 'idle' }, true);
    const pending = wait();
    const settled = track(pending);
    await Promise.resolve();
    expect(settled.done).toBe(false);
    state.value = { turnId: 't1', status: 'running' };
    await expect(pending).resolves.toEqual({ turnId: 't1', status: 'running' });
  });

  it('waits while the transcript baseline is still unknown', async () => {
    const { state, wait } = harness({ turnId: null, status: 'unknown' }, false);
    const pending = wait();
    const settled = track(pending);
    await Promise.resolve();
    expect(settled.done).toBe(false);
    state.value = { turnId: 't1', status: 'running' };
    await expect(pending).resolves.toEqual({ turnId: 't1', status: 'running' });
  });

  it('never reports a stale turn id from the previous turn as running', async () => {
    const { state, wait } = harness({ turnId: 't1', status: 'idle' }, true);
    const pending = wait();
    const settled = track(pending);
    await Promise.resolve();
    expect(settled.done).toBe(false);
    state.value = { turnId: 't2', status: 'running' };
    const result = await pending;
    expect(result).toEqual({ turnId: 't2', status: 'running' });
  });

  it('gives up at the deadline when no turn operation ever arrives', async () => {
    vi.useFakeTimers();
    const { wait } = harness({ turnId: 't1', status: 'idle' }, true);
    const pending = wait(100);
    const settled = track(pending);
    await vi.advanceTimersByTimeAsync(99);
    expect(settled.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ turnId: 't1', status: 'idle' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves immediately when neither the session nor the transcript has a running turn', async () => {
    vi.useFakeTimers();
    const { wait } = harness({ turnId: 't1', status: 'idle' }, false);
    await expect(wait()).resolves.toEqual({ turnId: 't1', status: 'idle' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves immediately when the turn is paused on a pending interaction', async () => {
    vi.useFakeTimers();
    const { wait } = harness({ turnId: 't1', status: 'paused' }, true);
    await expect(wait()).resolves.toEqual({ turnId: 't1', status: 'paused' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits while an answered approval is still resolving and resolves once the turn runs', async () => {
    vi.useFakeTimers();
    const { state, wait } = harness({ turnId: 't1', status: 'paused', resolving: true }, true);
    const pending = wait();
    const settled = track(pending);
    await vi.advanceTimersByTimeAsync(10);
    expect(settled.done).toBe(false);
    state.value = { turnId: 't1', status: 'running' };
    await expect(pending).resolves.toEqual({ turnId: 't1', status: 'running' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up at the deadline when an answered approval never resolves', async () => {
    vi.useFakeTimers();
    const { wait } = harness({ turnId: 't1', status: 'paused', resolving: true }, true);
    const pending = wait(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ turnId: 't1', status: 'paused', resolving: true });
  });

  it('stops watching once the wait settles', async () => {
    const state = ref<SessionExecutionState>({ turnId: null, status: 'idle' });
    const read = vi.fn(() => state.value);
    const pending = waitForSessionExecution({ read, turnActive: () => true, timeoutMs: 3000 });
    state.value = { turnId: 't1', status: 'running' };
    await pending;
    const readsAfterSettle = read.mock.calls.length;
    state.value = { turnId: 't2', status: 'running' };
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(readsAfterSettle);
  });
});
