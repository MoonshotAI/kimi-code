import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppMcpAuthBeginResult } from '@moonshot-ai/app-core/api';
import { setKimiClientDeps } from '../src/client/deps';

const apiMock = {
  getPluginInfo: vi.fn(),
  getMcpAuthStatuses: vi.fn(),
  inspectMcpAuthStatuses: vi.fn(),
  beginMcpAuth: vi.fn(),
  completeMcpAuth: vi.fn(),
  cancelMcpAuth: vi.fn(),
  resetMcpAuth: vi.fn(),
};

setKimiClientDeps({ api: () => apiMock as never, t: (key) => key });

import {
  __resetMcpAuthorizationForTests,
  useMcpAuthorization,
  type McpAuthorizationTarget,
} from '../src/composables/useMcpAuthorization';

const authorizationUrl = 'https://auth.example.test/authorize';
const target: McpAuthorizationTarget = {
  pluginId: 'vercel',
  serverName: 'vercel',
  runtimeName: 'plugin-vercel:vercel',
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function authorizationRequired(flowId = 'flow-1'): AppMcpAuthBeginResult {
  return { status: 'authorization-required', flowId, authorizationUrl };
}

describe('useMcpAuthorization', () => {
  let open: ReturnType<typeof vi.fn>;
  let popup: {
    closed: boolean;
    opener: unknown;
    location: { href: string };
    close: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    __resetMcpAuthorizationForTests();
    vi.resetAllMocks();
    apiMock.getPluginInfo.mockResolvedValue({ skills: [], mcpServers: [] });
    apiMock.getMcpAuthStatuses.mockResolvedValue([]);
    apiMock.inspectMcpAuthStatuses.mockResolvedValue([]);
    apiMock.beginMcpAuth.mockResolvedValue(authorizationRequired());
    apiMock.completeMcpAuth.mockImplementation(() => new Promise(() => {}));
    apiMock.cancelMcpAuth.mockResolvedValue(null);
    apiMock.resetMcpAuth.mockResolvedValue(null);
    popup = { closed: false, opener: {}, location: { href: '' }, close: vi.fn() };
    open = vi.fn(() => popup);
    vi.stubGlobal('window', { open });
  });

  afterEach(() => {
    __resetMcpAuthorizationForTests();
    vi.unstubAllGlobals();
  });

  it('shares concurrent flows and does not reopen after remounting', async () => {
    const begin = deferred<AppMcpAuthBeginResult>();
    apiMock.beginMcpAuth.mockReturnValue(begin.promise);
    const first = useMcpAuthorization();
    const second = useMcpAuthorization();

    const firstAuthorization = first.authorize(target);
    const secondAuthorization = second.authorize(target);
    expect(apiMock.beginMcpAuth).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(popup.location.href).toBe('');

    begin.resolve(authorizationRequired());
    await Promise.all([firstAuthorization, secondAuthorization]);
    await useMcpAuthorization().authorize(target);

    expect(apiMock.beginMcpAuth).toHaveBeenCalledTimes(1);
    expect(apiMock.completeMcpAuth).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.location.href).toBe(authorizationUrl);
  });

  it('does not report a successfully opened popup as blocked and clears its opener', async () => {
    const auth = useMcpAuthorization();

    await auth.authorize(target);

    expect(auth.states[target.runtimeName]?.openBlocked).toBeUndefined();
    expect(popup.opener).toBeNull();
  });

  it('waits in the background and refreshes after authorization succeeds', async () => {
    const completion = deferred<null>();
    apiMock.completeMcpAuth.mockReturnValue(completion.promise);
    const auth = useMcpAuthorization();

    await auth.authorize(target);
    expect(auth.states[target.runtimeName]).toMatchObject({
      phase: 'waiting',
      flowId: 'flow-1',
      authorizationUrl,
    });
    expect(apiMock.completeMcpAuth).toHaveBeenCalledWith({
      flowId: 'flow-1',
      timeoutMs: 900_000,
      signal: expect.any(AbortSignal),
    });

    completion.resolve(null);
    await vi.waitFor(() => {
      expect(auth.states[target.runtimeName]?.status).toBe('oauth-authorized');
    });
    expect(apiMock.getMcpAuthStatuses).toHaveBeenCalled();
    expect(auth.states[target.runtimeName]).toMatchObject({ phase: 'idle' });
  });

  it('keeps the current flow and manual link when the popup is blocked', async () => {
    open.mockReturnValue(null);
    const auth = useMcpAuthorization();

    await auth.authorize(target);
    await auth.authorize(target);

    expect(open).toHaveBeenCalledTimes(1);
    expect(apiMock.completeMcpAuth).toHaveBeenCalledTimes(1);
    expect(auth.states[target.runtimeName]).toMatchObject({
      phase: 'waiting',
      flowId: 'flow-1',
      authorizationUrl,
      openBlocked: true,
    });
  });

  it('cancels the active flow and allows an explicit retry', async () => {
    const auth = useMcpAuthorization();
    await auth.authorize(target);
    const signal = apiMock.completeMcpAuth.mock.calls[0]?.[0]?.signal as AbortSignal;

    await auth.cancel(target.runtimeName);

    expect(apiMock.cancelMcpAuth).toHaveBeenCalledWith('flow-1');
    expect(signal.aborted).toBe(true);
    expect(auth.states[target.runtimeName]).toMatchObject({
      phase: 'idle',
      cancelled: true,
    });

    apiMock.beginMcpAuth.mockResolvedValue(authorizationRequired('flow-2'));
    await auth.authorize(target);
    expect(open).toHaveBeenCalledTimes(2);
    expect(apiMock.beginMcpAuth).toHaveBeenCalledTimes(2);
  });

  it('reports cancellation after the completion watcher observes the cancelled flow first', async () => {
    const completion = deferred<null>();
    const cancellation = deferred<null>();
    apiMock.completeMcpAuth.mockReturnValue(completion.promise);
    apiMock.cancelMcpAuth.mockReturnValue(cancellation.promise);
    const auth = useMcpAuthorization();
    await auth.authorize(target);

    const cancelling = auth.cancel(target.runtimeName);
    completion.reject(new Error('flow cancelled'));
    await vi.waitFor(() => {
      expect(auth.states[target.runtimeName]?.error).toBe('flow cancelled');
    });
    cancellation.resolve(null);
    await cancelling;

    expect(auth.states[target.runtimeName]).toMatchObject({
      phase: 'idle',
      error: undefined,
      cancelled: true,
    });
  });

  it('retains the active flow after a cancellation failure and retries the same flow', async () => {
    apiMock.cancelMcpAuth.mockRejectedValueOnce(new Error('network unavailable'));
    const auth = useMcpAuthorization();
    await auth.authorize(target);
    const signal = apiMock.completeMcpAuth.mock.calls[0]?.[0]?.signal as AbortSignal;

    await auth.cancel(target.runtimeName);

    expect(auth.states[target.runtimeName]).toMatchObject({
      phase: 'waiting',
      flowId: 'flow-1',
      authorizationUrl,
      error: 'network unavailable',
    });
    expect(signal.aborted).toBe(false);
    await auth.authorize(target);
    expect(apiMock.beginMcpAuth).toHaveBeenCalledTimes(1);

    await auth.cancel(target.runtimeName);

    expect(apiMock.cancelMcpAuth).toHaveBeenCalledTimes(2);
    expect(apiMock.cancelMcpAuth).toHaveBeenNthCalledWith(2, 'flow-1');
    expect(signal.aborted).toBe(true);
    expect(auth.states[target.runtimeName]).toMatchObject({ phase: 'idle', cancelled: true });
  });

  it('keeps a completion failure manual without retrying on refresh', async () => {
    const completion = deferred<null>();
    apiMock.completeMcpAuth.mockReturnValue(completion.promise);
    const auth = useMcpAuthorization();
    await auth.authorize(target);

    completion.reject(new Error('authorization expired'));
    await vi.waitFor(() => {
      expect(auth.states[target.runtimeName]?.error).toBe('authorization expired');
    });
    await auth.refresh();

    expect(auth.states[target.runtimeName]).toMatchObject({ phase: 'idle' });
    expect(apiMock.beginMcpAuth).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('authorizes the first OAuth-required server in plugin manifest order', async () => {
    apiMock.getPluginInfo.mockResolvedValue({
      skills: [],
      mcpServers: [
        { name: 'stdio', runtimeName: 'plugin-vercel:stdio', enabled: true, transport: 'stdio' },
        { name: 'first', runtimeName: 'plugin-vercel:first', enabled: true, transport: 'http' },
        { name: 'second', runtimeName: 'plugin-vercel:second', enabled: true, transport: 'http' },
      ],
    });
    apiMock.inspectMcpAuthStatuses.mockResolvedValue([
      { name: 'plugin-vercel:second', authStatus: 'oauth-required' },
      { name: 'plugin-vercel:first', authStatus: 'oauth-required' },
      { name: 'plugin-vercel:stdio', authStatus: 'not-applicable' },
    ]);
    const auth = useMcpAuthorization();

    await auth.authorizePlugin('vercel');

    expect(apiMock.getPluginInfo).toHaveBeenCalledWith('vercel');
    expect(apiMock.beginMcpAuth).toHaveBeenCalledWith({
      source: 'plugin',
      pluginId: 'vercel',
      serverName: 'first',
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('uses fresh required statuses instead of a stale authorized cache', async () => {
    apiMock.getPluginInfo.mockResolvedValue({
      skills: [],
      mcpServers: [{
        name: target.serverName,
        runtimeName: target.runtimeName,
        enabled: true,
        transport: 'http',
      }],
    });
    apiMock.inspectMcpAuthStatuses.mockResolvedValue([
      { name: target.runtimeName, authStatus: 'oauth-required' },
    ]);
    const auth = useMcpAuthorization();
    auth.states[target.runtimeName] = { status: 'oauth-authorized', phase: 'idle' };

    await auth.authorizePlugin('vercel');

    expect(apiMock.beginMcpAuth).toHaveBeenCalledWith({
      source: 'plugin',
      pluginId: 'vercel',
      serverName: 'vercel',
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(auth.states[target.runtimeName]).toMatchObject({
      status: 'oauth-required',
      phase: 'waiting',
    });
  });

  it('opens automatic plugin authorization in a new tab', async () => {
    apiMock.getPluginInfo.mockResolvedValue({
      skills: [],
      mcpServers: [{
        name: target.serverName,
        runtimeName: target.runtimeName,
        enabled: true,
        transport: 'http',
      }],
    });
    apiMock.inspectMcpAuthStatuses.mockResolvedValue([
      { name: target.runtimeName, authStatus: 'oauth-required' },
    ]);
    const auth = useMcpAuthorization();

    await auth.authorizePlugin('vercel');

    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(popup.location.href).toBe(authorizationUrl);
    expect(apiMock.completeMcpAuth).toHaveBeenCalledTimes(1);
  });

  it('falls back to an explicit OAuth status when active inspection is unavailable', async () => {
    apiMock.getPluginInfo.mockResolvedValue({
      skills: [],
      mcpServers: [{
        name: target.serverName,
        runtimeName: target.runtimeName,
        enabled: true,
        transport: 'http',
      }],
    });
    apiMock.getMcpAuthStatuses.mockResolvedValue([
      { name: target.runtimeName, authStatus: 'oauth-required' },
    ]);
    apiMock.inspectMcpAuthStatuses.mockResolvedValue([
      { name: target.runtimeName, authStatus: 'unavailable' },
    ]);
    const auth = useMcpAuthorization();

    await auth.authorizePlugin('vercel');

    expect(apiMock.beginMcpAuth).toHaveBeenCalledWith({
      source: 'plugin',
      pluginId: 'vercel',
      serverName: 'vercel',
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('discovers OAuth through targeted active inspection after offline lookup misses it', async () => {
    apiMock.getPluginInfo.mockResolvedValue({
      skills: [],
      mcpServers: [
        { name: 'stdio', runtimeName: 'plugin-vercel:stdio', enabled: true, transport: 'stdio' },
        { name: 'disabled', runtimeName: 'plugin-vercel:disabled', enabled: false, transport: 'http' },
        {
          name: target.serverName,
          runtimeName: target.runtimeName,
          enabled: true,
          transport: 'http',
        },
      ],
    });
    apiMock.getMcpAuthStatuses.mockResolvedValue([
      { name: target.runtimeName, authStatus: 'not-applicable' },
    ]);
    apiMock.inspectMcpAuthStatuses.mockResolvedValue([
      { name: target.runtimeName, authStatus: 'oauth-required' },
    ]);
    const auth = useMcpAuthorization();

    await auth.authorizePlugin('vercel');

    expect(apiMock.inspectMcpAuthStatuses).toHaveBeenCalledWith([
      { source: 'plugin', pluginId: 'vercel', serverName: 'vercel' },
    ]);
    expect(apiMock.beginMcpAuth).toHaveBeenCalledWith({
      source: 'plugin',
      pluginId: 'vercel',
      serverName: 'vercel',
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it.each(['oauth-required', 'not-applicable'] as const)(
    'honors the offline %s state when the server accepts anonymous connections',
    async (offlineStatus) => {
      apiMock.getPluginInfo.mockResolvedValue({
        skills: [],
        mcpServers: [{ name: target.serverName, runtimeName: target.runtimeName, enabled: true, transport: 'http' }],
      });
      apiMock.getMcpAuthStatuses.mockResolvedValue([{ name: target.runtimeName, authStatus: offlineStatus }]);
      apiMock.inspectMcpAuthStatuses.mockResolvedValue([{ name: target.runtimeName, authStatus: 'not-applicable' }]);
      const auth = useMcpAuthorization();

      await auth.refresh(target.pluginId);
      expect(auth.states[target.runtimeName]?.status).toBe(offlineStatus);
      expect(apiMock.beginMcpAuth).not.toHaveBeenCalled();
      await auth.authorizePlugin(target.pluginId);
      const expectedFlows = offlineStatus === 'oauth-required' ? 1 : 0;
      expect(apiMock.beginMcpAuth).toHaveBeenCalledTimes(expectedFlows);
      expect(open).toHaveBeenCalledTimes(expectedFlows);
    },
  );

  it('shares a flow across runtime names without reopening or cancelling peers', async () => {
    const completion = deferred<null>();
    apiMock.completeMcpAuth.mockReturnValue(completion.promise);
    const other = {
      ...target,
      pluginId: 'other',
      serverName: 'other',
      runtimeName: 'plugin-other:other',
    };
    const auth = useMcpAuthorization();
    await auth.authorize(target);
    await auth.authorize(other);

    expect(apiMock.beginMcpAuth).toHaveBeenCalledTimes(2);
    expect(apiMock.completeMcpAuth).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2);
    expect(popup.close.mock.calls).toHaveLength(1);
    expect(popup.location.href).toBe(authorizationUrl);

    await auth.cancel(other.runtimeName);

    expect(apiMock.cancelMcpAuth).not.toHaveBeenCalled();
    expect(auth.states[other.runtimeName]).toMatchObject({ phase: 'idle', cancelled: true });
    expect(auth.states[target.runtimeName]).toMatchObject({ phase: 'waiting', flowId: 'flow-1' });

    completion.resolve(null);
    await vi.waitFor(() => {
      expect(auth.states[target.runtimeName]?.status).toBe('oauth-authorized');
    });
  });

  it('cancels a shared flow after the last runtime is cancelled', async () => {
    const other = {
      ...target,
      pluginId: 'other',
      serverName: 'other',
      runtimeName: 'plugin-other:other',
    };
    const auth = useMcpAuthorization();
    await auth.authorize(target);
    await auth.authorize(other);
    const signal = apiMock.completeMcpAuth.mock.calls[0]?.[0]?.signal as AbortSignal;

    await auth.cancel(other.runtimeName);
    await auth.cancel(target.runtimeName);

    expect(apiMock.cancelMcpAuth).toHaveBeenCalledOnce();
    expect(apiMock.cancelMcpAuth).toHaveBeenCalledWith('flow-1');
    expect(signal.aborted).toBe(true);
  });

  it('does not start authorization for a plugin without OAuth-required servers', async () => {
    apiMock.getPluginInfo.mockResolvedValue({
      skills: [],
      mcpServers: [
        { name: 'stdio', runtimeName: 'plugin-vercel:stdio', enabled: true, transport: 'stdio' },
      ],
    });
    apiMock.getMcpAuthStatuses.mockResolvedValue([
      { name: 'plugin-vercel:stdio', authStatus: 'not-applicable' },
    ]);
    const auth = useMcpAuthorization();

    await auth.authorizePlugin('vercel');

    expect(apiMock.beginMcpAuth).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps plugin authorization discovery failures out of the install result', async () => {
    apiMock.getPluginInfo.mockRejectedValue(new Error('details unavailable'));
    const auth = useMcpAuthorization();

    await auth.authorizePlugin('vercel');

    expect(auth.states.vercel).toMatchObject({
      phase: 'idle',
      discoveryError: 'details unavailable',
    });
    expect(apiMock.beginMcpAuth).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('clears recovered plugin discovery errors on refresh', async () => {
    const auth = useMcpAuthorization();
    auth.states.vercel = { phase: 'idle', discoveryError: 'details unavailable' };

    await auth.refresh();

    expect(auth.states.vercel.discoveryError).toBeUndefined();
  });

  it('preserves runtime operation errors after a successful status refresh', async () => {
    apiMock.getMcpAuthStatuses.mockResolvedValue([
      { name: target.runtimeName, authStatus: 'oauth-authorized' },
    ]);
    const auth = useMcpAuthorization();
    auth.states[target.runtimeName] = {
      status: 'oauth-authorized',
      phase: 'idle',
      error: 'reset failed',
    };

    await auth.refresh();

    expect(auth.states[target.runtimeName]?.error).toBe('reset failed');
  });

  it('clears plugin discovery errors after a server authorization succeeds', async () => {
    const completion = deferred<null>();
    apiMock.completeMcpAuth.mockReturnValue(completion.promise);
    const auth = useMcpAuthorization();
    auth.states.vercel = { phase: 'idle', discoveryError: 'details unavailable' };
    await auth.authorize(target);

    completion.resolve(null);
    await vi.waitFor(() => {
      expect(auth.states[target.runtimeName]?.status).toBe('oauth-authorized');
    });

    expect(auth.states.vercel.discoveryError).toBeUndefined();
  });

  it('ignores stale refresh results and failures', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    apiMock.getMcpAuthStatuses
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const auth = useMcpAuthorization();

    const firstRefresh = auth.refresh();
    const secondRefresh = auth.refresh();
    second.resolve([{ name: target.runtimeName, authStatus: 'oauth-required' }]);
    await secondRefresh;
    first.resolve([{ name: target.runtimeName, authStatus: 'not-applicable' }]);
    await firstRefresh;
    expect(auth.states[target.runtimeName]?.status).toBe('oauth-required');

    const rejected = deferred<unknown>();
    const latest = deferred<unknown>();
    apiMock.getMcpAuthStatuses
      .mockReturnValueOnce(rejected.promise)
      .mockReturnValueOnce(latest.promise);
    const staleRequest = auth.refresh();
    const latestRequest = auth.refresh();
    rejected.reject(new Error('stale failure'));
    await expect(staleRequest).resolves.toBeUndefined();
    latest.resolve([{ name: target.runtimeName, authStatus: 'oauth-authorized' }]);
    await latestRequest;
    expect(auth.states[target.runtimeName]?.status).toBe('oauth-authorized');
  });

  it('refreshes plugin details with targeted required and authorized states without starting authorization', async () => {
    apiMock.getPluginInfo.mockResolvedValue({
      skills: [],
      mcpServers: [{
        name: target.serverName,
        runtimeName: target.runtimeName,
        enabled: true,
        transport: 'http',
      }],
    });
    apiMock.getMcpAuthStatuses.mockResolvedValue([
      { name: target.runtimeName, authStatus: 'not-applicable' },
    ]);
    apiMock.inspectMcpAuthStatuses.mockResolvedValue([
      { name: target.runtimeName, authStatus: 'oauth-required' },
    ]);
    const auth = useMcpAuthorization();

    await auth.refresh('vercel');
    expect(auth.states[target.runtimeName]).toMatchObject({
      status: 'oauth-required',
      phase: 'idle',
    });

    apiMock.inspectMcpAuthStatuses.mockResolvedValue([
      { name: target.runtimeName, authStatus: 'oauth-authorized' },
    ]);
    await auth.refresh('vercel');
    expect(auth.states[target.runtimeName]).toMatchObject({
      status: 'oauth-authorized',
      phase: 'idle',
    });
    expect(apiMock.inspectMcpAuthStatuses).toHaveBeenCalledTimes(2);
    expect(apiMock.inspectMcpAuthStatuses).toHaveBeenCalledWith([
      { source: 'plugin', pluginId: 'vercel', serverName: 'vercel' },
    ]);
    expect(apiMock.beginMcpAuth).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('refreshes statuses without starting authorization', async () => {
    apiMock.getMcpAuthStatuses.mockResolvedValue([
      { name: target.runtimeName, authStatus: 'oauth-expired' },
    ]);
    const auth = useMcpAuthorization();

    await auth.refresh();

    expect(auth.states[target.runtimeName]).toMatchObject({
      status: 'oauth-expired',
      phase: 'idle',
    });
    expect(apiMock.beginMcpAuth).not.toHaveBeenCalled();
    expect(apiMock.completeMcpAuth).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('uses the desktop system browser when the bridge is available', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { open, kimiDesktop: { openExternal } });
    const auth = useMcpAuthorization();

    await auth.authorize(target);

    expect(openExternal).toHaveBeenCalledWith(authorizationUrl);
    expect(open).not.toHaveBeenCalled();
    expect(auth.states[target.runtimeName]?.openBlocked).toBeUndefined();
  });

  it('resets stored credentials and allows a fresh authorization', async () => {
    const completion = deferred<null>();
    apiMock.completeMcpAuth.mockReturnValue(completion.promise);
    const auth = useMcpAuthorization();
    await auth.authorize(target);
    completion.resolve(null);
    await vi.waitFor(() => {
      expect(auth.states[target.runtimeName]?.status).toBe('oauth-authorized');
    });

    apiMock.getPluginInfo.mockResolvedValue({
      skills: [],
      mcpServers: [{ name: target.serverName, runtimeName: target.runtimeName, enabled: true, transport: 'http' }],
    });
    apiMock.getMcpAuthStatuses.mockResolvedValue([{ name: target.runtimeName, authStatus: 'not-applicable' }]);
    apiMock.inspectMcpAuthStatuses.mockResolvedValue([{ name: target.runtimeName, authStatus: 'oauth-required' }]);
    await auth.reset(target);

    expect(apiMock.inspectMcpAuthStatuses).toHaveBeenCalledWith([
      { source: 'plugin', pluginId: target.pluginId, serverName: target.serverName },
    ]);
    expect(apiMock.beginMcpAuth).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(apiMock.resetMcpAuth).toHaveBeenCalledWith({
      source: 'plugin',
      pluginId: 'vercel',
      serverName: 'vercel',
    });
    expect(auth.states[target.runtimeName]).toMatchObject({
      status: 'oauth-required',
      phase: 'idle',
      cancelled: true,
    });

    apiMock.beginMcpAuth.mockResolvedValue(authorizationRequired('flow-2'));
    await auth.authorize(target);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('keeps the authorized state visible when resetting credentials fails', async () => {
    apiMock.resetMcpAuth.mockRejectedValue(new Error('reset failed'));
    const auth = useMcpAuthorization();
    auth.states[target.runtimeName] = { status: 'oauth-authorized', phase: 'idle' };

    await auth.reset(target);

    expect(auth.states[target.runtimeName]).toMatchObject({
      status: 'oauth-authorized',
      phase: 'idle',
      error: 'reset failed',
    });
  });

  it('invalidates cached idle plugin statuses as soon as a targeted refresh starts', async () => {
    const inspection = deferred<unknown>();
    apiMock.getPluginInfo.mockResolvedValue({
      skills: [],
      mcpServers: [{ name: target.serverName, runtimeName: target.runtimeName, enabled: true, transport: 'http' }],
    });
    apiMock.inspectMcpAuthStatuses.mockReturnValue(inspection.promise);
    const auth = useMcpAuthorization();
    auth.states[target.runtimeName] = { status: 'oauth-authorized', phase: 'idle' };
    auth.states['plugin-other:other'] = { status: 'oauth-authorized', phase: 'idle' };

    const pending = auth.refresh('vercel');

    expect(auth.states[target.runtimeName]?.status).toBeUndefined();
    expect(auth.states['plugin-other:other']?.status).toBe('oauth-authorized');

    inspection.resolve([{ name: target.runtimeName, authStatus: 'oauth-required' }]);
    await pending;

    expect(auth.states[target.runtimeName]).toMatchObject({
      status: 'oauth-required',
      phase: 'idle',
    });
  });

  it('preserves runtime operation errors when a targeted refresh invalidates stale status', async () => {
    apiMock.getPluginInfo.mockResolvedValue({
      skills: [],
      mcpServers: [{ name: target.serverName, runtimeName: target.runtimeName, enabled: true, transport: 'http' }],
    });
    apiMock.inspectMcpAuthStatuses.mockResolvedValue([
      { name: target.runtimeName, authStatus: 'oauth-authorized' },
    ]);
    const auth = useMcpAuthorization();
    auth.states[target.runtimeName] = {
      status: 'oauth-authorized',
      phase: 'idle',
      error: 'reset failed',
    };

    const pending = auth.refresh('vercel');
    expect(auth.states[target.runtimeName]).toMatchObject({
      status: undefined,
      error: 'reset failed',
    });
    await pending;

    expect(auth.states[target.runtimeName]).toMatchObject({
      status: 'oauth-authorized',
      phase: 'idle',
      error: 'reset failed',
    });
  });

  it('preserves active flows when a targeted refresh invalidates cached plugin statuses', async () => {
    const inspection = deferred<unknown>();
    apiMock.getPluginInfo.mockResolvedValue({
      skills: [],
      mcpServers: [{ name: target.serverName, runtimeName: target.runtimeName, enabled: true, transport: 'http' }],
    });
    apiMock.inspectMcpAuthStatuses.mockReturnValue(inspection.promise);
    const auth = useMcpAuthorization();
    await auth.authorize(target);

    const pending = auth.refresh('vercel');

    expect(auth.states[target.runtimeName]).toMatchObject({
      status: 'oauth-required',
      phase: 'waiting',
      flowId: 'flow-1',
    });

    inspection.resolve([{ name: target.runtimeName, authStatus: 'oauth-required' }]);
    await pending;
    expect(auth.states[target.runtimeName]?.phase).toBe('waiting');
  });

  it('marks plugin discovery as starting and drops stale authorized state on automatic authorization', async () => {
    const inspection = deferred<unknown>();
    apiMock.getPluginInfo.mockResolvedValue({
      skills: [],
      mcpServers: [{ name: target.serverName, runtimeName: target.runtimeName, enabled: true, transport: 'http' }],
    });
    apiMock.inspectMcpAuthStatuses.mockReturnValue(inspection.promise);
    const auth = useMcpAuthorization();
    auth.states[target.runtimeName] = { status: 'oauth-authorized', phase: 'idle' };

    const pending = auth.authorizePlugin('vercel');

    expect(auth.states[target.runtimeName]?.status).toBeUndefined();
    expect(auth.states.vercel?.phase).toBe('starting');

    inspection.resolve([{ name: target.runtimeName, authStatus: 'oauth-required' }]);
    await pending;

    expect(auth.states.vercel?.phase).toBe('idle');
    expect(auth.states[target.runtimeName]).toMatchObject({
      status: 'oauth-required',
      phase: 'waiting',
    });
  });

  it('clears a stale authorized status while explicit authorization is starting', async () => {
    const begin = deferred<AppMcpAuthBeginResult>();
    apiMock.beginMcpAuth.mockReturnValue(begin.promise);
    const auth = useMcpAuthorization();
    auth.states[target.runtimeName] = { status: 'oauth-authorized', phase: 'idle' };

    const pending = auth.authorize(target);

    expect(auth.states[target.runtimeName]).toMatchObject({
      status: undefined,
      phase: 'starting',
    });

    begin.resolve(authorizationRequired());
    await pending;
    expect(auth.states[target.runtimeName]).toMatchObject({
      status: 'oauth-required',
      phase: 'waiting',
    });
  });
});
