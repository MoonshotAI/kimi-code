import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  connectionStore,
  getEventConn,
  setEventConn,
  type SessionWorkBaselineRun,
} from '../src/stores/connection';
import { sessionsStore } from '../src/stores/sessions';

function makeConn() {
  return {
    subscribeConversation: vi.fn(),
    unsubscribeConversation: vi.fn(),
    health: () => ({ connected: true, open: true, stale: false }),
    reconnect: vi.fn(),
    close: vi.fn(),
  };
}

function makeBaselineRun(): SessionWorkBaselineRun {
  return {
    workEventSessions: new Set(),
    titleEventSessions: new Set(),
    pendingEventSourceBySession: new Map(),
  };
}

let sidSeq = 0;
function sid(): string {
  sidSeq += 1;
  return `s-${sidSeq}`;
}

beforeEach(() => {
  const store = connectionStore();
  store.connected = false;
  store.connection = 'disconnected';
  store.connectionGeneration = 0;
  store.wsEverConnected = false;
  store.wsDisconnectedAt = null;
  store.eventCountBySession.clear();
  store.sessionWorkBaseline.run = null;
  store.sessionWorkBaseline.attempts = 0;
  store.sessionWorkBaseline.lastError = null;
  store.sessionWorkBaseline.cooldownUntil = null;
  store.cancelSessionWorkBaselineRetry();
  setEventConn(null);
  sessionsStore().setSessions([]);
  sessionsStore().setActiveSessionId(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('eventConn accessor', () => {
  it('round-trips the module-level singleton', () => {
    expect(getEventConn()).toBeNull();
    const conn = makeConn();
    setEventConn(conn);
    expect(getEventConn()).toBe(conn);
    setEventConn(null);
    expect(getEventConn()).toBeNull();
  });
});

describe('session event count', () => {
  it('counts the events seen per session', () => {
    const s = sid();
    const other = sid();
    const store = connectionStore();
    expect(store.sessionEventCount(s)).toBe(0);
    store.noteSessionEvent(s);
    store.noteSessionEvent(s);
    store.noteSessionEvent(other);
    expect(store.sessionEventCount(s)).toBe(2);
    expect(store.sessionEventCount(other)).toBe(1);
  });
});

describe('connection state transitions', () => {
  it('markConnecting only moves the connection label', () => {
    const store = connectionStore();
    store.markConnecting();
    expect(store.connection).toBe('connecting');
    expect(store.connected).toBe(false);
  });

  it('markConnected bumps the generation and reports the previous downtime', () => {
    vi.useFakeTimers();
    const store = connectionStore();
    expect(store.markConnected()).toBeNull();
    expect(store.connected).toBe(true);
    expect(store.connection).toBe('connected');
    expect(store.connectionGeneration).toBe(1);
    expect(store.wsEverConnected).toBe(true);

    expect(store.markDisconnected()).toBe(true);
    expect(store.connected).toBe(false);
    expect(store.connection).toBe('disconnected');
    const downAt = store.wsDisconnectedAt;
    expect(downAt).not.toBeNull();

    vi.advanceTimersByTime(500);
    expect(store.markConnected()).toBe(downAt);
    expect(store.wsDisconnectedAt).toBeNull();
    expect(store.connectionGeneration).toBe(2);
  });

  it('markDisconnected before the first connect reports no live loss', () => {
    expect(connectionStore().markDisconnected()).toBe(false);
    expect(connectionStore().wsDisconnectedAt).toBeNull();
  });

  it('markDisconnected clears the baseline run and retry backoff', () => {
    vi.useFakeTimers();
    const store = connectionStore();
    store.markConnected();
    store.beginSessionWorkBaseline(makeBaselineRun());
    store.scheduleSessionWorkBaselineRetry(new Error('boom'), () => undefined);
    expect(store.sessionWorkBaseline.retryTimer).not.toBeNull();

    store.markDisconnected();

    expect(store.sessionWorkBaseline.run).toBeNull();
    expect(store.sessionWorkBaseline.attempts).toBe(0);
    expect(store.sessionWorkBaseline.lastError).toBeNull();
    expect(store.sessionWorkBaseline.retryTimer).toBeNull();
    expect(store.sessionWorkBaseline.cooldownUntil).toBeNull();
  });
});

describe('session work baseline', () => {
  it('begin/current/clear track the in-flight run', () => {
    const store = connectionStore();
    const run = makeBaselineRun();
    expect(store.sessionWorkBaseline.run).toBeNull();
    expect(store.isSessionWorkBaselineCurrent(run)).toBe(false);

    store.beginSessionWorkBaseline(run);
    expect(store.sessionWorkBaseline.run).toBe(run);
    expect(store.isSessionWorkBaselineCurrent(run)).toBe(true);
    expect(store.isSessionWorkBaselineCurrent(makeBaselineRun())).toBe(false);

    store.clearSessionWorkBaseline();
    expect(store.sessionWorkBaseline.run).toBeNull();
    expect(store.isSessionWorkBaselineCurrent(run)).toBe(false);
  });

  it('scheduleSessionWorkBaselineRetry backs off and fires the retry once', () => {
    vi.useFakeTimers();
    const store = connectionStore();
    store.markConnected();
    const error = new Error('partial');
    const retry = vi.fn();

    store.scheduleSessionWorkBaselineRetry(error, retry);

    expect(store.sessionWorkBaseline.attempts).toBe(1);
    expect(store.sessionWorkBaseline.lastError).toBe(error);
    expect(store.sessionWorkBaseline.cooldownUntil).toBe(Date.now() + 1000);
    expect(store.sessionWorkBaseline.retryTimer).not.toBeNull();
    expect(retry).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(store.sessionWorkBaseline.retryTimer).toBeNull();
    expect(store.sessionWorkBaseline.cooldownUntil).toBeNull();

    store.scheduleSessionWorkBaselineRetry(error, retry);
    expect(store.sessionWorkBaseline.attempts).toBe(2);
    expect(store.sessionWorkBaseline.cooldownUntil).toBe(Date.now() + 2000);
    vi.advanceTimersByTime(2000);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('does not schedule while disconnected or while a retry is pending', () => {
    vi.useFakeTimers();
    const store = connectionStore();
    const retry = vi.fn();

    store.scheduleSessionWorkBaselineRetry(new Error('x'), retry);
    expect(store.sessionWorkBaseline.attempts).toBe(0);
    expect(store.sessionWorkBaseline.retryTimer).toBeNull();

    store.markConnected();
    store.scheduleSessionWorkBaselineRetry(new Error('x'), retry);
    store.scheduleSessionWorkBaselineRetry(new Error('y'), retry);
    expect(store.sessionWorkBaseline.attempts).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('cancelSessionWorkBaselineRetry clears the pending timer', () => {
    vi.useFakeTimers();
    const store = connectionStore();
    store.markConnected();
    const retry = vi.fn();
    store.scheduleSessionWorkBaselineRetry(new Error('x'), retry);

    store.cancelSessionWorkBaselineRetry();

    expect(store.sessionWorkBaseline.retryTimer).toBeNull();
    expect(store.sessionWorkBaseline.cooldownUntil).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(retry).not.toHaveBeenCalled();
  });

  it('resetSessionWorkBaselineBackoff zeroes the attempts and the last error', () => {
    vi.useFakeTimers();
    const store = connectionStore();
    store.markConnected();
    store.scheduleSessionWorkBaselineRetry(new Error('x'), () => undefined);

    store.resetSessionWorkBaselineBackoff();

    expect(store.sessionWorkBaseline.attempts).toBe(0);
    expect(store.sessionWorkBaseline.lastError).toBeNull();
  });
});

describe('forgetSession', () => {
  it('drops the event count of the session', () => {
    const s = sid();
    const other = sid();
    const store = connectionStore();
    store.noteSessionEvent(s);
    store.noteSessionEvent(other);

    store.forgetSession(s);

    expect(store.sessionEventCount(s)).toBe(0);
    expect(store.sessionEventCount(other)).toBe(1);
  });
});
