import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetKimiClientDeps, setKimiClientDeps } from '../../../../packages/app-client/src/client/deps';
import { warningsStore, workspacesStore } from '@moonshot-ai/app-client/stores';

const getKimiWebApiMock = vi.fn();

beforeEach(() => {
  getKimiWebApiMock.mockReset();
  setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
  const store = workspacesStore();
  store.removeWorkspaceEntries('ws/1', '/repo/ws1');
  store.workspaces = [{ id: 'ws/1', root: '/repo/ws1', name: 'ws1', sessionCount: 1, kind: 'implicit', additionalDirs: [] }];
  store.storedActiveWorkspaceId = 'ws/1';
  store.trustByWorkspaceId = {};
  store.trustErrorByWorkspaceId = {};
  store.trustLoadingByWorkspaceId = {};
  warningsStore().resetWarnings();
});

afterEach(() => {
  warningsStore().resetWarnings();
  resetKimiClientDeps();
});

describe('workspacesStore workspace trust', () => {
  it('ensureWorkspaceTrust fetches once and records the result', async () => {
    const getWorkspaceTrust = vi.fn().mockResolvedValue({ trusted: true });
    getKimiWebApiMock.mockReturnValue({ getWorkspaceTrust });
    const store = workspacesStore();

    await store.ensureWorkspaceTrust('ws/1');
    expect(getWorkspaceTrust).toHaveBeenCalledTimes(1);
    expect(store.trustByWorkspaceId['ws/1']).toBe(true);

    await store.ensureWorkspaceTrust('ws/1');
    expect(getWorkspaceTrust).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent ensure calls', async () => {
    let resolveFetch!: (value: { trusted: boolean }) => void;
    const getWorkspaceTrust = vi.fn().mockImplementation(
      () => new Promise<{ trusted: boolean }>((resolve) => { resolveFetch = resolve; }),
    );
    getKimiWebApiMock.mockReturnValue({ getWorkspaceTrust });
    const store = workspacesStore();

    const first = store.ensureWorkspaceTrust('ws/1');
    const second = store.ensureWorkspaceTrust('ws/1');
    resolveFetch({ trusted: false });
    await Promise.all([first, second]);

    expect(getWorkspaceTrust).toHaveBeenCalledTimes(1);
    expect(store.trustByWorkspaceId['ws/1']).toBe(false);
  });

  it('does not record trust when the read was aborted', async () => {
    let resolveFetch!: (value: { trusted: boolean }) => void;
    const getWorkspaceTrust = vi.fn().mockImplementation(
      () => new Promise<{ trusted: boolean }>((resolve) => { resolveFetch = resolve; }),
    );
    getKimiWebApiMock.mockReturnValue({ getWorkspaceTrust });
    const store = workspacesStore();

    const controller = new AbortController();
    const pending = store.ensureWorkspaceTrust('ws/1', { background: true, signal: controller.signal });
    controller.abort();
    resolveFetch({ trusted: true });
    await pending;

    expect(store.trustByWorkspaceId['ws/1']).toBeUndefined();
  });

  it('returns the original read error, dedupes its toast, and allows a later retry', async () => {
    const failure = Object.assign(new Error('trust storage unavailable'), {
      name: 'DaemonApiError',
      code: 50001,
      requestId: 'req-trust-read',
    });
    const getWorkspaceTrust = vi.fn().mockRejectedValueOnce(failure);
    getKimiWebApiMock.mockReturnValue({ getWorkspaceTrust });
    const store = workspacesStore();

    const failed = await store.ensureWorkspaceTrust('ws/1');
    expect(failed.status).toBe('error');
    if (failed.status === 'error') {
      expect(failed.error).toMatchObject({
        operation: 'read',
        message: failure.message,
        code: 50001,
        requestId: 'req-trust-read',
        originalError: failure,
      });
      expect(store.trustErrorByWorkspaceId['ws/1']).toEqual(failed.error);
    }
    expect(store.trustByWorkspaceId['ws/1']).toBeUndefined();
    expect(store.trustLoadingByWorkspaceId['ws/1']).toBe(false);
    expect(warningsStore().warnings).toHaveLength(1);
    expect(warningsStore().warnings[0]).toMatchObject({
      severity: 'error',
      title: 'workspace.trust.readFailedTitle',
      message: failure.message,
      details: expect.arrayContaining([
        { label: 'warnings.details.requestId', value: 'req-trust-read' },
      ]),
    });

    const nextFailure = Object.assign(new Error(failure.message), {
      name: 'DaemonApiError',
      code: 50001,
      requestId: 'req-trust-read-2',
    });
    getWorkspaceTrust.mockRejectedValueOnce(nextFailure);
    const failedAgain = await store.ensureWorkspaceTrust('ws/1');
    expect(failedAgain.status).toBe('error');
    if (failedAgain.status === 'error') {
      expect(failedAgain.error.requestId).toBe('req-trust-read-2');
    }
    expect(warningsStore().warnings).toHaveLength(1);

    getWorkspaceTrust.mockResolvedValueOnce({ trusted: false });
    const retried = await store.ensureWorkspaceTrust('ws/1');
    expect(retried).toEqual({ status: 'success', trusted: false });
    expect(store.trustByWorkspaceId['ws/1']).toBe(false);
    expect(store.trustErrorByWorkspaceId['ws/1']).toBeUndefined();
  });

  it('trustWorkspace records trust with the daemon', async () => {
    const trustWorkspace = vi.fn().mockResolvedValue({ trusted: true });
    getKimiWebApiMock.mockReturnValue({ trustWorkspace });
    const store = workspacesStore();

    await store.trustWorkspace('ws/1');
    expect(trustWorkspace).toHaveBeenCalledTimes(1);
    expect(store.trustByWorkspaceId['ws/1']).toBe(true);
  });

  it('preserves network status and cause in read errors', async () => {
    const cause = new Error('connection refused');
    const failure = Object.assign(new Error('daemon request failed', { cause }), {
      name: 'DaemonNetworkError',
      method: 'GET',
      path: '/api/v1/workspaces/ws/1/trust',
      requestId: 'req-trust-network',
      status: 503,
    });
    const getWorkspaceTrust = vi.fn().mockRejectedValue(failure);
    getKimiWebApiMock.mockReturnValue({ getWorkspaceTrust });
    const store = workspacesStore();

    const result = await store.ensureWorkspaceTrust('ws/1');

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toMatchObject({
        message: failure.message,
        requestId: 'req-trust-network',
        status: 503,
        cause,
        originalError: failure,
      });
    }
  });

  it('returns write errors without converting them to trust state', async () => {
    const failure = Object.assign(new Error('trust marker is read-only'), {
      name: 'DaemonApiError',
      code: 50001,
      requestId: 'req-trust-write',
    });
    const trustWorkspace = vi.fn().mockRejectedValue(failure);
    getKimiWebApiMock.mockReturnValue({ trustWorkspace });
    const store = workspacesStore();

    const result = await store.trustWorkspace('ws/1');

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toMatchObject({
        operation: 'write',
        message: failure.message,
        requestId: 'req-trust-write',
        originalError: failure,
      });
      expect(store.trustErrorByWorkspaceId['ws/1']).toEqual(result.error);
    }
    expect(store.trustByWorkspaceId['ws/1']).toBeUndefined();
    expect(warningsStore().warnings).toHaveLength(1);
    expect(warningsStore().warnings[0]).toMatchObject({
      severity: 'error',
      title: 'workspace.trust.writeFailedTitle',
      message: failure.message,
      details: expect.arrayContaining([
        { label: 'warnings.details.requestId', value: 'req-trust-write' },
      ]),
    });
  });

  it('trustWorkspace invalidates an inflight read so a late response cannot overwrite it', async () => {
    let resolveFetch!: (value: { trusted: boolean }) => void;
    const getWorkspaceTrust = vi.fn().mockImplementation(
      () => new Promise<{ trusted: boolean }>((resolve) => { resolveFetch = resolve; }),
    );
    const trustWorkspace = vi.fn().mockResolvedValue({ trusted: true });
    getKimiWebApiMock.mockReturnValue({ getWorkspaceTrust, trustWorkspace });
    const store = workspacesStore();

    const pending = store.ensureWorkspaceTrust('ws/1');
    await store.trustWorkspace('ws/1');
    resolveFetch({ trusted: false });
    await pending;

    expect(store.trustByWorkspaceId['ws/1']).toBe(true);
  });

  it('does not toast a stale read error and notifies when that workspace is current again', async () => {
    let rejectFetch!: (error: unknown) => void;
    const getWorkspaceTrust = vi.fn().mockImplementationOnce(
      () => new Promise<{ trusted: boolean }>((_, reject) => { rejectFetch = reject; }),
    );
    getKimiWebApiMock.mockReturnValue({ getWorkspaceTrust });
    const store = workspacesStore();
    const pending = store.ensureWorkspaceTrust('ws/1');
    store.workspaces = [
      { id: 'ws/1', root: '/repo/ws1', name: 'ws1', sessionCount: 1, kind: 'implicit', additionalDirs: [] },
      { id: 'ws/2', root: '/repo/ws2', name: 'ws2', sessionCount: 1, kind: 'implicit', additionalDirs: [] },
    ];
    store.storedActiveWorkspaceId = 'ws/2';
    const failure = Object.assign(new Error('stale trust read failed'), {
      name: 'DaemonApiError',
      code: 50001,
      requestId: 'req-stale-trust',
    });

    rejectFetch(failure);
    const stale = await pending;
    expect(stale.status).toBe('error');
    expect(warningsStore().warnings).toHaveLength(0);

    getWorkspaceTrust.mockRejectedValueOnce(failure);
    store.storedActiveWorkspaceId = 'ws/1';
    await store.ensureWorkspaceTrust('ws/1');
    expect(warningsStore().warnings).toHaveLength(1);
  });

  it('does not toast a stale write error when returning without another request', async () => {
    let rejectWrite!: (error: unknown) => void;
    const trustWorkspace = vi.fn().mockImplementationOnce(
      () => new Promise<{ trusted: boolean }>((_, reject) => { rejectWrite = reject; }),
    );
    getKimiWebApiMock.mockReturnValue({ trustWorkspace });
    const store = workspacesStore();
    store.trustByWorkspaceId = { 'ws/1': false };
    store.workspaces = [
      { id: 'ws/1', root: '/repo/ws1', name: 'ws1', sessionCount: 1, kind: 'implicit', additionalDirs: [] },
      { id: 'ws/2', root: '/repo/ws2', name: 'ws2', sessionCount: 1, kind: 'implicit', additionalDirs: [] },
    ];
    const pending = store.trustWorkspace('ws/1');
    store.storedActiveWorkspaceId = 'ws/2';
    const failure = Object.assign(new Error('stale trust write failed'), {
      name: 'DaemonApiError',
      code: 50001,
      requestId: 'req-stale-write',
    });

    rejectWrite(failure);
    const stale = await pending;
    expect(stale.status).toBe('error');
    expect(warningsStore().warnings).toHaveLength(0);

    store.storedActiveWorkspaceId = 'ws/1';
    await Promise.resolve();
    expect(warningsStore().warnings).toHaveLength(0);
    expect(trustWorkspace).toHaveBeenCalledOnce();
  });

  it('distinguishes network failures with different causes', async () => {
    const failure = (causeMessage: string) => Object.assign(
      new Error('daemon request failed', { cause: new Error(causeMessage) }),
      {
        name: 'DaemonNetworkError',
        method: 'GET',
        path: '/api/v1/workspaces/ws/1/trust',
        requestId: `req-${causeMessage}`,
        status: 503,
      },
    );
    const getWorkspaceTrust = vi.fn()
      .mockRejectedValueOnce(failure('first cause'))
      .mockRejectedValueOnce(failure('second cause'));
    getKimiWebApiMock.mockReturnValue({ getWorkspaceTrust });
    const store = workspacesStore();

    await store.ensureWorkspaceTrust('ws/1');
    await store.ensureWorkspaceTrust('ws/1');

    expect(warningsStore().warnings).toHaveLength(2);
    expect(JSON.stringify(warningsStore().warnings[1])).toContain('second cause');
  });

  it('removeWorkspaceEntries clears trust state for the removed workspace', () => {
    getKimiWebApiMock.mockReturnValue({});
    const store = workspacesStore();
    store.trustByWorkspaceId = { 'ws/1': true };
    store.trustErrorByWorkspaceId = {
      'ws/1': { operation: 'read', message: 'boom', originalError: new Error('boom') },
    };
    store.trustLoadingByWorkspaceId = { 'ws/1': true };

    store.removeWorkspaceEntries('ws/1', '/repo/ws1');

    expect(store.trustByWorkspaceId['ws/1']).toBeUndefined();
    expect(store.trustErrorByWorkspaceId['ws/1']).toBeUndefined();
    expect(store.trustLoadingByWorkspaceId['ws/1']).toBe(false);
  });
});
