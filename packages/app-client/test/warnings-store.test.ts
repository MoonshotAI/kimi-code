import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonApiError, DaemonNetworkError } from '@moonshot-ai/app-core/api';
import type { KimiWebApi } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { warningsStore, operationFailureNotice, warningDetail } from '../src/stores/warnings';
import { sessionsStore } from '../src/stores/sessions';

const traceKeyEvent = vi.fn();

beforeEach(() => {
  warningsStore().resetWarnings();
  traceKeyEvent.mockReset();
  setKimiClientDeps({ t: (key) => key, traceKeyEvent });
});

afterEach(() => {
  resetKimiClientDeps();
});

describe('warningsStore refreshSessionWarnings', () => {
  const getSessionWarnings = vi.fn<KimiWebApi['getSessionWarnings']>();

  beforeEach(() => {
    getSessionWarnings.mockReset();
    warningsStore().forgetSessionWarnings('s1');
    sessionsStore().setSessions([{ id: 's1', cwd: '/repo' } as never]);
    setKimiClientDeps({
      api: () => ({ getSessionWarnings }) as unknown as KimiWebApi,
      t: (key) => key,
      traceKeyEvent,
    });
  });

  it('skips an already cancelled read', () => {
    warningsStore().refreshSessionWarnings('s1', { signal: AbortSignal.abort() });
    expect(getSessionWarnings).not.toHaveBeenCalled();
  });

  it('does not display or mark cancelled warnings as shown', async () => {
    const controller = new AbortController();
    const options = { signal: controller.signal, background: true };
    let resolveFirst!: (list: Awaited<ReturnType<KimiWebApi['getSessionWarnings']>>) => void;
    const list = [{ code: 'warning', message: 'read warning', severity: 'warning' as const }];
    getSessionWarnings
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(list);

    warningsStore().refreshSessionWarnings('s1', options);
    expect(getSessionWarnings).toHaveBeenCalledWith('s1', options);
    controller.abort();
    resolveFirst(list);
    await Promise.resolve();
    expect(warningsStore().warnings).toEqual([]);

    warningsStore().refreshSessionWarnings('s1');
    await vi.waitFor(() => expect(warningsStore().warnings).toHaveLength(1));
    expect(getSessionWarnings).toHaveBeenLastCalledWith('s1');
    warningsStore().refreshSessionWarnings('s1');
    await Promise.resolve();
    expect(warningsStore().warnings).toHaveLength(1);
  });

  it('does not turn cancellation into an operation failure', async () => {
    const controller = new AbortController();
    getSessionWarnings.mockRejectedValue(new DOMException('cancelled', 'AbortError'));

    warningsStore().refreshSessionWarnings('s1', { signal: controller.signal });
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();

    expect(warningsStore().warnings).toEqual([]);
    expect(traceKeyEvent).not.toHaveBeenCalled();
  });
});

describe('warningsStore list operations', () => {
  it('setWarnings replaces the list and pushWarning appends', () => {
    const store = warningsStore();
    store.setWarnings([{ severity: 'info', title: 'a' }]);
    store.pushWarning({ severity: 'error', title: 'b' });
    expect(store.warnings).toEqual([
      { severity: 'info', title: 'a', position: 'bottom-right' },
      { severity: 'error', title: 'b', position: 'bottom-right' },
    ]);
  });

  it('keeps an explicitly assigned notice position', () => {
    const store = warningsStore();
    store.pushWarning({ severity: 'info', title: 'a', position: 'top-right' });
    expect(store.warnings).toEqual([{ severity: 'info', title: 'a', position: 'top-right' }]);
  });

  it('dismissWarning removes the matching notice instance', () => {
    const store = warningsStore();
    store.setWarnings([
      { severity: 'info', title: 'same', position: 'bottom-right' },
      { severity: 'info', title: 'same', position: 'top-right' },
    ]);
    store.dismissWarning(store.warnings[0]);
    expect(store.warnings).toEqual([{ severity: 'info', title: 'same', position: 'top-right' }]);
  });

  it('dismissWsError removes only the ws connection errors', () => {
    const store = warningsStore();
    store.setWarnings([
      { severity: 'error', title: 'warnings.wsTitle' },
      { severity: 'error', title: 'other' },
    ]);
    store.dismissWsError();
    expect(store.warnings).toEqual([{ severity: 'error', title: 'other', position: 'bottom-right' }]);
  });
});

describe('warningDetail', () => {
  it('returns undefined for empty values and a labelled detail otherwise', () => {
    expect(warningDetail('message', undefined)).toBeUndefined();
    expect(warningDetail('message', '')).toBeUndefined();
    expect(warningDetail('code', 40913)).toEqual({ label: 'warnings.details.code', value: '40913' });
  });
});

describe('operationFailureNotice', () => {
  it('structures a daemon api error with the api title and the error message', () => {
    const err = new DaemonApiError({ code: 40913, msg: 'goal already exists', requestId: 'r1' });
    const notice = operationFailureNotice('createGoal', err);
    expect(notice.severity).toBe('error');
    expect(notice.title).toBe('warnings.daemonApiTitle');
    expect(notice.message).toBe('goal already exists');
    const labels = (notice.details ?? []).map((d) => d.label);
    expect(labels).toContain('warnings.details.operation');
    expect(labels).toContain('warnings.details.code');
    expect(labels).toContain('warnings.details.requestId');
  });

  it('uses the timeout title for network timeouts', () => {
    const err = new DaemonNetworkError({
      message: 'timeout',
      cause: { name: 'TimeoutError' },
      url: 'http://x',
      method: 'GET',
      path: '/x',
      timeoutMs: 5000,
      phase: 'fetch',
    } as never);
    const notice = operationFailureNotice('load', err);
    expect(notice.title).toBe('warnings.daemonTimeoutTitle');
    expect(notice.message).toBe('warnings.daemonTimeoutMessage');
  });

  it('falls back to the generic operation-failure shape for plain errors', () => {
    const notice = operationFailureNotice('load', new Error('boom'));
    expect(notice.title).toBe('warnings.operationFailedTitle');
    expect(notice.message).toBe('warnings.operationFailedMessage');
  });

  it('honors explicit title and message overrides', () => {
    const notice = operationFailureNotice('op', new Error('x'), { title: 'T', message: 'M' });
    expect(notice.title).toBe('T');
    expect(notice.message).toBe('M');
  });
});

describe('warningsStore pushOperationFailure', () => {
  it('traces and pushes the structured notice', () => {
    const err = new DaemonApiError({ code: 40913, msg: 'goal already exists', requestId: 'r1' });
    warningsStore().pushOperationFailure('createGoal', err, { sessionId: 's1' });

    expect(traceKeyEvent).toHaveBeenCalledWith(
      'operation:failed',
      expect.objectContaining({ operation: 'createGoal', errorCode: 40913, sessionId: 's1' }),
    );
    expect(warningsStore().warnings).toHaveLength(1);
    expect(warningsStore().warnings[0]).toMatchObject({
      severity: 'error',
      title: 'warnings.daemonApiTitle',
      message: 'goal already exists',
    });
  });
});
