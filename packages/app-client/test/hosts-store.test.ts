import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppHost } from '@moonshot-ai/app-core/api';

import { setKimiClientDeps } from '../src/client/deps';
import { hostsStore, setHostsHooks } from '../src/stores/hosts';
import { modelsStore } from '../src/stores/models';

const api = {
  listHosts: vi.fn(),
  connectHost: vi.fn(),
  putHost: vi.fn(),
  deleteHost: vi.fn(),
  listHostSshConfig: vi.fn(async () => ({ configPath: '', exists: false, hosts: [] })),
  copyProvidersToHost: vi.fn(),
  deviceApi: vi.fn(),
};

const remote = {
  getMeta: vi.fn(),
  getAuth: vi.fn(),
  logout: vi.fn(),
  startOAuthLogin: vi.fn(),
  pollOAuthLogin: vi.fn(),
  cancelOAuthLogin: vi.fn(),
  getOAuthRegion: vi.fn(),
  listModels: vi.fn(),
  getConfig: vi.fn(),
};

function auth(status: string | null, modelsReady = false) {
  return { modelsReady, providersCount: modelsReady ? 1 : 0, managedProvider: status === null ? null : { status } };
}

function host(id: string, extra: Partial<AppHost> = {}): AppHost {
  return { id, host: `${id}.example.test`, status: 'pending', ...extra };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  for (const fn of Object.values(remote)) fn.mockReset();
  api.deviceApi.mockReturnValue(remote);
  remote.getAuth.mockResolvedValue(auth(null));
  remote.getMeta.mockResolvedValue({ experimentalFlags: {} });
  remote.listModels.mockResolvedValue([]);
  remote.getConfig.mockResolvedValue({});
  setKimiClientDeps({ api: () => api as never, t: (key) => key });
  setHostsHooks(null);
  const store = hostsStore();
  store.byId = {};
  store.loaded = false;
  store.connecting = {};
  store.providerCopies = {};
  store.accounts = {};
  store.experimentalFlags.clear();
  store.loginHostId = null;
  api.listHosts.mockResolvedValue([]);
});

describe('hosts store', () => {
  describe('remote flag discovery', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('recovers from a temporary failure on the same connection and caches the result', async () => {
      const store = hostsStore();
      const ready = host('example', { status: 'ready' });
      api.listHosts.mockResolvedValue([ready]);
      remote.getMeta.mockRejectedValueOnce(new Error('Temporarily unavailable'))
        .mockResolvedValue({ experimentalFlags: { desktop_feedback: true } });

      await store.load();
      await vi.runAllTimersAsync();
      expect(store.experimentalFlags.get(ready.id)?.['desktop_feedback']).toBe(true);
      await store.load();
      expect(remote.getMeta).toHaveBeenCalledTimes(2);
    });

    it('bounds failed retries and invalidates them when a host is disabled', async () => {
      const store = hostsStore();
      const ready = host('example', { status: 'ready' });
      api.listHosts.mockResolvedValue([ready]);
      remote.getMeta.mockRejectedValue(new Error('Temporarily unavailable'));

      await store.load();
      await vi.runAllTimersAsync();
      expect(remote.getMeta).toHaveBeenCalledTimes(2);
      expect(store.experimentalFlags.get(ready.id)?.['desktop_feedback']).not.toBe(true);

      await store.load();
      store.applySnapshot([{ ...ready, enabled: false }]);
      remote.getMeta.mockResolvedValue({ experimentalFlags: { desktop_feedback: true } });
      await vi.runAllTimersAsync();
      expect(remote.getMeta).toHaveBeenCalledTimes(3);
      expect(store.experimentalFlags.has(ready.id)).toBe(false);

      await store.load();
      expect(store.experimentalFlags.get(ready.id)?.['desktop_feedback']).toBe(true);
      store.applySnapshot([{ ...ready, enabled: false }]);
      expect(store.experimentalFlags.has(ready.id)).toBe(false);
    });
  });

  it('reads flags from each ready host and drops replies from a previous connection', async () => {
    const first = Promise.withResolvers<{ experimentalFlags: Record<string, boolean> }>();
    const second = Promise.withResolvers<{ experimentalFlags: Record<string, boolean> }>();
    remote.getMeta.mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ experimentalFlags: { desktop_feedback: true } })
      .mockReturnValueOnce(second.promise);
    const store = hostsStore();
    const available = (id: string) => store.experimentalFlags.get(id)?.['desktop_feedback'] === true;
    const a = host('example-a', { status: 'ready' });
    const b = host('example-b', { status: 'ready' });
    store.applySnapshot([a, b]);
    await vi.waitFor(() => expect(available(b.id)).toBe(true));
    expect(available(a.id)).toBe(false);
    store.applySnapshot([a, b]);
    expect(remote.getMeta).toHaveBeenCalledTimes(2);

    store.applySnapshot([{ ...a, status: 'disconnected' }, b]);
    store.applySnapshot([a, b]);
    second.resolve({ experimentalFlags: {} });
    await second.promise;
    first.resolve({ experimentalFlags: { desktop_feedback: true } });
    await first.promise;
    expect(available(a.id)).toBe(false);
    expect(available(b.id)).toBe(true);
    store.applySnapshot([]);
    expect(available(b.id)).toBe(false);
  });

  it('copies shareable local providers to a ready host without repeating in-flight copies and refreshes the host', async () => {
    api.copyProvidersToHost.mockResolvedValue({ providers: ['gateway', 'backup'] });
    const store = hostsStore();
    store.applySnapshot([host('devbox', { status: 'ready' }), host('idle')]);
    await vi.waitFor(() => expect(store.accounts['devbox']?.status).toBe('signedOut'));
    remote.getAuth.mockResolvedValue(auth(null, true));

    await store.copyProviders('idle');
    expect(api.copyProvidersToHost).not.toHaveBeenCalled();

    const pending = store.copyProviders('devbox');
    expect(store.providerCopies['devbox']).toEqual({ status: 'copying' });
    await store.copyProviders('devbox');
    await pending;
    expect(api.copyProvidersToHost).toHaveBeenCalledExactlyOnceWith('devbox');
    expect(store.providerCopies['devbox']).toEqual({ status: 'done', result: { providers: ['gateway', 'backup'] } });
    expect(remote.listModels).toHaveBeenCalled();
    await vi.waitFor(() => expect(store.needsLogin('devbox')).toBe(false));
  });

  it('reports a failed copy and forgets the copies of removed hosts', async () => {
    api.copyProvidersToHost.mockRejectedValueOnce(new Error('boom'));
    const store = hostsStore();
    store.applySnapshot([host('devbox', { status: 'ready' })]);
    await store.copyProviders('devbox');
    expect(store.providerCopies['devbox']).toEqual({ status: 'failed' });

    store.applySnapshot([host('devbox', { status: 'disconnected' })]);
    expect(store.providerCopies['devbox']?.status).toBe('failed');
    store.applySnapshot([]);
    expect(store.providerCopies).toEqual({});
  });

  it('derives display states from the host records', async () => {
    api.listHosts.mockResolvedValue([
      host('devbox', { status: 'disconnected', connectError: 'Connection refused' }),
      host('paused', { enabled: false }),
    ]);
    const store = hostsStore();
    expect(store.displayState('devbox')).toBe('idle');
    await store.load();

    expect(store.displayState(undefined)).toBe('local');
    expect(store.displayState('devbox')).toBe('failed');
    expect(store.displayState('paused')).toBe('disabled');
    expect(store.displayState('gone')).toBe('missing');
    expect(store.unavailable('paused')).toBe(true);
    expect(store.unavailable('devbox')).toBe(false);

    store.applySnapshot([host('devbox', { status: 'ready' })]);
    expect(store.displayState('devbox')).toBe('ready');
    expect(store.displayState('paused')).toBe('missing');
  });

  it('names a host by its name, then its id, and reports a removed one as unnamed', async () => {
    api.listHosts.mockResolvedValue([host('named', { name: 'Build box' }), host('devbox')]);
    expect(hostsStore().displayName('named')).toBe('');
    await hostsStore().load();
    expect(hostsStore().displayName('named')).toBe('Build box');
    expect(hostsStore().displayName('devbox')).toBe('devbox');
    expect(hostsStore().displayName('gone')).toBeUndefined();
  });

  it('reports host lifecycle transitions and notifies registered hooks', async () => {
    const store = hostsStore();
    const onHostsChanged = vi.fn();
    setHostsHooks({ onHostsChanged });
    remote.listModels.mockResolvedValue([{ id: 'remote-m', model: 'remote-m', provider: 'managed:kimi-code' }]);
    remote.getConfig.mockResolvedValue({ defaultModel: 'remote-m' });

    expect(store.applySnapshot([host('devbox'), host('ready', { status: 'ready' })])).toEqual({
      becameReady: ['ready'],
      becameDisabled: [],
      removed: [],
    });
    await modelsStore().loadHostCatalog('ready');
    modelsStore().setActiveHost('ready');
    expect(modelsStore().activeModels.map((m) => m.id)).toEqual(['remote-m']);

    expect(store.applySnapshot([host('devbox', { status: 'ready' }), host('ready', { status: 'ready' })])).toEqual({
      becameReady: ['devbox'],
      becameDisabled: [],
      removed: [],
    });
    expect(store.applySnapshot([host('devbox', { status: 'disconnected', enabled: false }), host('ready', { status: 'ready' })])).toEqual({
      becameReady: [],
      becameDisabled: ['devbox'],
      removed: [],
    });
    expect(store.applySnapshot([host('devbox', { status: 'disconnected', enabled: false })])).toEqual({
      becameReady: [],
      becameDisabled: [],
      removed: ['ready'],
    });
    expect(modelsStore().activeHostId).toBeUndefined();
    expect(onHostsChanged).toHaveBeenLastCalledWith({
      becameReady: [],
      becameDisabled: [],
      removed: ['ready'],
    });
  });

  it('marks a host connecting until the connect request settles and does not repeat it', async () => {
    let resolve!: (value: unknown) => void;
    api.listHosts.mockResolvedValue([host('devbox')]);
    api.connectHost.mockReturnValue(new Promise((next) => { resolve = next; }));
    const store = hostsStore();
    await store.load();
    const pending = store.connect('devbox');
    const duplicate = store.connect('devbox');

    expect(store.displayState('devbox')).toBe('connecting');
    resolve(host('devbox', { status: 'ready' }));
    await Promise.all([pending, duplicate]);
    expect(api.connectHost).toHaveBeenCalledExactlyOnceWith('devbox');
    expect(store.connecting).toEqual({});
  });

  it('saves and removes hosts through the host API and reloads the list', async () => {
    const store = hostsStore();
    await store.save('devbox', { host: 'devbox.example.test', name: 'Dev' });
    expect(api.putHost).toHaveBeenCalledExactlyOnceWith('devbox', { host: 'devbox.example.test', name: 'Dev' });
    await store.remove('devbox');
    expect(api.deleteHost).toHaveBeenCalledExactlyOnceWith('devbox');
    expect(api.listHosts).toHaveBeenCalledTimes(2);
  });

  it('reads the Kimi account of a host once it is ready and forgets it when the host drops', async () => {
    remote.getAuth.mockResolvedValue(auth('authenticated'));
    const store = hostsStore();
    store.applySnapshot([host('devbox', { status: 'ready' })]);

    await vi.waitFor(() => expect(store.accounts['devbox']).toEqual({ status: 'signedIn', modelsReady: false }));
    expect(api.deviceApi).toHaveBeenCalledWith('devbox');
    expect(store.needsLogin('devbox')).toBe(false);

    store.applySnapshot([host('devbox', { status: 'disconnected' })]);
    expect(store.accounts).toEqual({});
  });

  it('asks a signed-out host to sign in only when it has no models, and signs out on the host', async () => {
    const store = hostsStore();
    store.applySnapshot([host('devbox', { status: 'ready' })]);
    await vi.waitFor(() => expect(store.accounts['devbox']).toEqual({ status: 'signedOut', modelsReady: false }));
    expect(store.needsLogin('devbox')).toBe(true);
    expect(store.needsLogin(undefined)).toBe(false);

    remote.getAuth.mockResolvedValue(auth(null, true));
    await store.loadAccount('devbox');
    expect(store.needsLogin('devbox')).toBe(false);

    remote.getAuth.mockResolvedValue(auth('authenticated', true));
    await store.loadAccount('devbox');
    expect(store.accounts['devbox']).toEqual({ status: 'signedIn', modelsReady: true });

    remote.logout.mockResolvedValue({ loggedOut: true });
    remote.getAuth.mockResolvedValue(auth(null));
    await store.signOut('devbox');
    expect(remote.logout).toHaveBeenCalledOnce();
    expect(store.accounts['devbox']).toEqual({ status: 'signedOut', modelsReady: false });
  });

  it('runs the login flow on the host and reloads its account and models afterwards', async () => {
    const store = hostsStore();
    store.applySnapshot([host('devbox', { status: 'ready' }), host('offline')]);
    store.openLogin('offline');
    expect(store.loginHostId).toBeNull();
    await expect(store.startLogin('global')).rejects.toThrow('No SSH host is signing in');
    store.openLogin('devbox');
    expect(store.loginHostId).toBe('devbox');

    remote.startOAuthLogin.mockResolvedValue({ flowId: 'f1', provider: 'managed:kimi-code', status: 'authenticated' });
    remote.pollOAuthLogin.mockResolvedValue(null);
    remote.getOAuthRegion.mockResolvedValue('global');
    await expect(store.startLogin('global')).resolves.toMatchObject({ flowId: 'f1' });
    await expect(store.pollLogin()).resolves.toBeNull();
    await store.cancelLogin();
    await expect(store.loginRegion()).resolves.toBe('global');
    expect(remote.startOAuthLogin).toHaveBeenCalledExactlyOnceWith('global');
    expect(remote.cancelOAuthLogin).toHaveBeenCalledOnce();

    remote.getAuth.mockClear();
    remote.getAuth.mockResolvedValue(auth('authenticated', true));
    store.finishLogin();
    expect(store.loginHostId).toBeNull();
    await vi.waitFor(() => expect(store.accounts['devbox']?.status).toBe('signedIn'));
    expect(remote.listModels).toHaveBeenCalled();

    store.openLogin('devbox');
    store.applySnapshot([host('devbox', { status: 'disconnected' })]);
    expect(store.loginHostId).toBeNull();
  });
});
