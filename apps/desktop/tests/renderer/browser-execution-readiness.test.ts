import { afterEach, expect, it, vi } from 'vitest';
import { ref, watch } from 'vue';
import { waitForSessionExecution, type SessionExecutionState } from '@moonshot-ai/app-client/lib';
import { browserCommandTakesControl, createBrowserCommandGate, prepareBrowserExecution } from '../../src/renderer/lib/browserExecutionReadiness';

afterEach(() => vi.useRealTimers());

function gate(execution: SessionExecutionState): SessionExecutionState {
  if (execution.status !== 'running' || execution.turnId === null) {
    throw new Error('Browser control requires a running turn.');
  }
  return execution;
}

it('retains the session until its baseline is ready and hands the lease to the caller', async () => {
  let complete!: () => void;
  const release = Object.assign(vi.fn(), { ready: new Promise<void>(resolve => { complete = resolve; }) });
  let prepared = false;
  const pending = prepareBrowserExecution(() => release).then(value => { prepared = true; return value; });
  await Promise.resolve();
  expect(prepared).toBe(false);
  expect(release).not.toHaveBeenCalled();
  complete();
  const lease = await pending;
  expect(prepared).toBe(true);
  expect(release).not.toHaveBeenCalled();
  lease();
  expect(release).toHaveBeenCalledOnce();
});

it('releases a failed preparation', async () => {
  const release = Object.assign(vi.fn(), { ready: Promise.reject(new Error('offline')) });
  await expect(prepareBrowserExecution(() => release)).rejects.toThrow('offline');
  expect(release).toHaveBeenCalledOnce();
});

it('hands the unspent part of the budget to the execution-state wait', async () => {
  vi.useFakeTimers();
  let complete!: () => void;
  const release = Object.assign(vi.fn(), { ready: new Promise<void>(resolve => { complete = resolve; }) });
  const settle = vi.fn((remainingMs: number) => Promise.resolve(remainingMs));
  const pending = prepareBrowserExecution(() => release, 3000, settle);
  await vi.advanceTimersByTimeAsync(1200);
  complete();
  const lease = await pending;
  expect(settle).toHaveBeenCalledOnce();
  expect(settle.mock.calls[0]![0]).toBeLessThanOrEqual(1800);
  expect(settle.mock.calls[0]![0]).toBeGreaterThan(0);
  expect(release).not.toHaveBeenCalled();
  lease();
  expect(release).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('releases the lease when the execution-state wait fails', async () => {
  const release = Object.assign(vi.fn(), { ready: Promise.resolve() });
  await expect(
    prepareBrowserExecution(() => release, 3000, () => Promise.reject(new Error('gone'))),
  ).rejects.toThrow('gone');
  expect(release).toHaveBeenCalledOnce();
});

it('times out and cannot continue a cancelled preparation after a late baseline', async () => {
  vi.useFakeTimers();
  let complete!: () => void;
  const release = Object.assign(vi.fn(), { ready: new Promise<void>(resolve => { complete = resolve; }) });
  const run = vi.fn();
  const pending = prepareBrowserExecution(() => release, 100).then(run);
  const rejected = expect(pending).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  complete();
  await Promise.resolve();
  expect(run).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('lets a first-turn browser command through once the turn operation lands inside the budget', async () => {
  const execution = ref<SessionExecutionState>({ turnId: null, status: 'idle' });
  const release = Object.assign(vi.fn(), { ready: Promise.resolve() });
  let settled: SessionExecutionState | undefined;
  const pending = prepareBrowserExecution(() => release, 3000, remainingMs =>
    waitForSessionExecution({ read: () => execution.value, turnActive: () => true, timeoutMs: remainingMs })
      .then(state => { settled = state; }));
  await Promise.resolve();
  expect(settled).toBeUndefined();
  execution.value = { turnId: 't1', status: 'running' };
  const lease = await pending;
  expect(gate(execution.value).turnId).toBe('t1');
  expect(settled).toEqual({ turnId: 't1', status: 'running' });
  lease();
});

it('refuses a browser command at the deadline when the turn operation never lands', async () => {
  vi.useFakeTimers();
  const execution = ref<SessionExecutionState>({ turnId: null, status: 'idle' });
  const release = Object.assign(vi.fn(), { ready: Promise.resolve() });
  let ready = false;
  const pending = prepareBrowserExecution(() => release, 3000, remainingMs =>
    waitForSessionExecution({ read: () => execution.value, turnActive: () => true, timeoutMs: remainingMs }))
    .then(lease => { ready = true; return lease; });
  await vi.advanceTimersByTimeAsync(2999);
  expect(ready).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const lease = await pending;
  expect(() => gate(execution.value)).toThrow('Browser control requires a running turn.');
  lease();
  expect(release).toHaveBeenCalledOnce();
});

it('lets a browser command through once an answered approval resolves into the running turn', async () => {
  vi.useFakeTimers();
  const execution = ref<SessionExecutionState>({ turnId: 't1', status: 'paused', resolving: true });
  const release = Object.assign(vi.fn(), { ready: Promise.resolve() });
  const pending = prepareBrowserExecution(() => release, 3000, remainingMs =>
    waitForSessionExecution({ read: () => execution.value, turnActive: () => true, timeoutMs: remainingMs }));
  await vi.advanceTimersByTimeAsync(10);
  execution.value = { turnId: 't1', status: 'running' };
  const lease = await pending;
  expect(gate(execution.value).turnId).toBe('t1');
  lease();
});

it('refuses a browser command at once while the turn waits on an unanswered approval', async () => {
  vi.useFakeTimers();
  const execution = ref<SessionExecutionState>({ turnId: 't1', status: 'paused' });
  const release = Object.assign(vi.fn(), { ready: Promise.resolve() });
  const lease = await prepareBrowserExecution(() => release, 3000, remainingMs =>
    waitForSessionExecution({ read: () => execution.value, turnActive: () => true, timeoutMs: remainingMs }));
  expect(vi.getTimerCount()).toBe(0);
  expect(() => gate(execution.value)).toThrow('Browser control requires a running turn.');
  lease();
});

function gateSession(controlled: boolean, resolving: { value: boolean }, receivedAt = 0) {
  const release = vi.fn();
  const prepare = vi.fn((_timeoutMs: number) => Promise.resolve(release));
  return { release, prepare, session: { receivedAt, controlled, resolving: () => resolving.value, prepare } };
}

function stuckSession(clock: { value: number }, resolving: { value: boolean }, receivedAt = clock.value) {
  const prepare = vi.fn(async (timeoutMs: number) => {
    clock.value += timeoutMs;
    throw new Error('Session state loading timed out');
  });
  return { receivedAt, controlled: true, resolving: () => resolving.value, prepare };
}

it('marks only the tab-taking commands as needing a running turn', () => {
  expect(browserCommandTakesControl('create_tab')).toBe(true);
  expect(browserCommandTakesControl('activate_tab')).toBe(true);
  for (const action of ['get_state', 'activate_panel', 'switch_tab', 'release_tab', 'close_tab']) {
    expect(browserCommandTakesControl(action)).toBe(false);
  }
});

it('waits on a state request only while an answered approval resolves in a controlled session', async () => {
  const gate = createBrowserCommandGate({ now: () => 0 });
  const resolving = { value: true };
  const uncontrolled = gateSession(false, resolving);
  expect(await gate.enter('get_state', 's1', uncontrolled.session)).toBeUndefined();
  expect(uncontrolled.prepare).not.toHaveBeenCalled();
  const settled = gateSession(true, { value: false });
  expect(await gate.enter('get_state', 's1', settled.session)).toBeUndefined();
  expect(settled.prepare).not.toHaveBeenCalled();
  for (const action of ['activate_panel', 'switch_tab', 'release_tab', 'close_tab']) {
    const other = gateSession(true, resolving);
    expect(await gate.enter(action, 's1', other.session)).toBeUndefined();
    expect(other.prepare).not.toHaveBeenCalled();
  }
  const waiting = gateSession(true, resolving);
  expect(await gate.enter('get_state', 's1', waiting.session)).toBe(waiting.release);
  expect(waiting.prepare).toHaveBeenCalledWith(3000);
});

it('lets an explicitly trusted run create or activate while the main turn is idle', async () => {
  const gate = createBrowserCommandGate({ now: () => 0 });
  const idle = gateSession(false, { value: false });
  expect(await gate.enter('create_tab', 's1', idle.session, true)).toBeUndefined();
  expect(idle.prepare).not.toHaveBeenCalled();
  expect(await gate.enter('activate_tab', 's1', idle.session, true)).toBeUndefined();
  expect(idle.prepare).not.toHaveBeenCalled();
  expect(await gate.enter('create_tab', 's1', idle.session)).toBe(idle.release);
  expect(idle.prepare).toHaveBeenCalledOnce();
});

it('prepares the tab-taking commands within the budget left since the request arrived and lets their failure through', async () => {
  const clock = { value: 0 };
  const gate = createBrowserCommandGate({ now: () => clock.value });
  const create = gateSession(false, { value: false });
  expect(await gate.enter('create_tab', 's1', create.session)).toBe(create.release);
  expect(create.prepare).toHaveBeenCalledWith(3000);
  clock.value = 1200;
  const queued = gateSession(false, { value: false });
  await gate.enter('activate_tab', 's1', queued.session);
  expect(queued.prepare).toHaveBeenCalledWith(1800);
  const failing = { receivedAt: clock.value, controlled: true, resolving: () => true, prepare: () => Promise.reject(new Error('Session state loading timed out')) };
  await expect(gate.enter('activate_tab', 's1', failing)).rejects.toThrow('Session state loading timed out');
});

it('answers a state request without failing when its wait times out', async () => {
  const clock = { value: 0 };
  const gate = createBrowserCommandGate({ now: () => clock.value });
  const timedOut = stuckSession(clock, { value: true });
  expect(await gate.enter('get_state', 's1', timedOut)).toBeUndefined();
  expect(timedOut.prepare).toHaveBeenCalledOnce();
});

it('shares one budget across the commands of a single resolving window', async () => {
  const clock = { value: 0 };
  const gate = createBrowserCommandGate({ now: () => clock.value });
  const resolving = { value: true };
  const first = stuckSession(clock, resolving);
  expect(await gate.enter('get_state', 's1', first)).toBeUndefined();
  expect(first.prepare).toHaveBeenCalledWith(3000);
  const switched = gateSession(true, resolving, clock.value);
  expect(await gate.enter('switch_tab', 's1', switched.session)).toBeUndefined();
  const later = gateSession(true, resolving, clock.value);
  expect(await gate.enter('get_state', 's1', later.session)).toBeUndefined();
  expect(later.prepare).not.toHaveBeenCalled();
  const other = gateSession(true, resolving, clock.value);
  expect(await gate.enter('get_state', 's2', other.session)).toBe(other.release);
  expect(other.prepare).toHaveBeenCalledWith(3000);
});

it('keeps a state request queued behind a take-control wait inside its own arrival budget', async () => {
  const clock = { value: 0 };
  const gate = createBrowserCommandGate({ now: () => clock.value });
  const resolving = { value: true };
  await expect(gate.enter('activate_tab', 's1', stuckSession(clock, resolving, 0))).rejects.toThrow('Session state loading timed out');
  const queued = gateSession(true, resolving, 10);
  expect(await gate.enter('get_state', 's1', queued.session)).toBeUndefined();
  expect(queued.prepare).not.toHaveBeenCalled();
});

it('spends only the unspent part of the budget on a later state request in the same window', async () => {
  const clock = { value: 0 };
  const gate = createBrowserCommandGate({ now: () => clock.value });
  const resolving = { value: true };
  const first = gateSession(true, resolving);
  first.prepare.mockImplementation(async () => { clock.value += 1000; return first.release; });
  await gate.enter('get_state', 's1', first.session);
  const second = gateSession(true, resolving, clock.value);
  await gate.enter('get_state', 's1', second.session);
  expect(second.prepare).toHaveBeenCalledWith(2000);
});

it('gives the next resolving window a fresh budget as soon as the previous one ends', async () => {
  const clock = { value: 0 };
  const resolving = ref(true);
  const stops: (() => void)[] = [];
  const gate = createBrowserCommandGate({
    now: () => clock.value,
    watchResolving: (_sessionId, ended) => {
      const stop = watch(resolving, value => { if (!value) ended(); }, { flush: 'sync' });
      stops.push(stop);
      return stop;
    },
  });
  await gate.enter('get_state', 's1', stuckSession(clock, resolving));
  resolving.value = false;
  resolving.value = true;
  const next = gateSession(true, resolving, clock.value);
  expect(await gate.enter('get_state', 's1', next.session)).toBe(next.release);
  expect(next.prepare).toHaveBeenCalledWith(3000);
  expect(stops).toHaveLength(2);
});

it('gives the next resolving window a fresh budget once a wait sees the approval land', async () => {
  const clock = { value: 0 };
  const gate = createBrowserCommandGate({ now: () => clock.value });
  const resolving = { value: true };
  const landed = gateSession(true, resolving);
  landed.prepare.mockImplementation(async () => { clock.value += 2500; resolving.value = false; return landed.release; });
  await gate.enter('get_state', 's1', landed.session);
  resolving.value = true;
  const next = gateSession(true, resolving, clock.value);
  await gate.enter('get_state', 's1', next.session);
  expect(next.prepare).toHaveBeenCalledWith(3000);
});

it('answers a state request with the running turn once the answered approval lands', async () => {
  vi.useFakeTimers();
  const execution = ref<SessionExecutionState>({ turnId: 't1', status: 'paused', resolving: true });
  const release = Object.assign(vi.fn(), { ready: Promise.resolve() });
  let answered: SessionExecutionState | undefined;
  const pending = prepareBrowserExecution(() => release, 3000, remainingMs =>
    waitForSessionExecution({ read: () => execution.value, turnActive: () => true, timeoutMs: remainingMs }))
    .then(lease => { answered = execution.value; return lease; });
  await vi.advanceTimersByTimeAsync(40);
  expect(answered).toBeUndefined();
  execution.value = { turnId: 't1', status: 'running' };
  const lease = await pending;
  expect(answered).toEqual({ turnId: 't1', status: 'running' });
  expect(vi.getTimerCount()).toBe(0);
  lease();
  expect(release).toHaveBeenCalledOnce();
});

it('answers a state request with the paused turn at the deadline when the approval never lands', async () => {
  vi.useFakeTimers();
  const execution = ref<SessionExecutionState>({ turnId: 't1', status: 'paused', resolving: true });
  const release = Object.assign(vi.fn(), { ready: Promise.resolve() });
  let answered = false;
  const pending = prepareBrowserExecution(() => release, 3000, remainingMs =>
    waitForSessionExecution({ read: () => execution.value, turnActive: () => true, timeoutMs: remainingMs }))
    .then(lease => { answered = true; return lease; });
  await vi.advanceTimersByTimeAsync(2999);
  expect(answered).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const lease = await pending;
  expect(execution.value.status).toBe('paused');
  expect(vi.getTimerCount()).toBe(0);
  lease();
});
