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
  listProviders: vi.fn(),
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
  remote.getMeta.mockResolvedValue({ capabilities: {} });
  remote.getAuth.mockResolvedValue(auth(null));
  remote.listModels.mockResolvedValue([]);
  remote.getConfig.mockResolvedValue({});
  remote.listProviders.mockResolvedValue([]);
  setKimiClientDeps({ api: () => api as never, t: (key) => key });
  setHostsHooks(null);
  const store = hostsStore();
  store.applySnapshot([]);
  store.loaded = false;
  store.connecting = {};
  store.providerCopies = {};
  store.accounts = {};
  store.loginHostId = null;
  api.listHosts.mockResolvedValue([]);
});

describe('hosts store', () => {
  describe('feedback support', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('enables local feedback and only trusts an explicit capability on each ready host', async () => {
      const store = hostsStore();
      const supported = host('supported', { status: 'ready' });
      const legacy = host('legacy', { status: 'ready' });
      const disabled = host('disabled', { status: 'ready', enabled: false });
      const supportedMeta = vi.fn().mockResolvedValue({ capabilities: { feedback: true } });
      const legacyMeta = vi.fn().mockResolvedValue({ capabilities: {}, experimentalFlags: { desktop_feedback: true } });
      api.deviceApi.mockImplementation((id: string) => ({ ...remote, getMeta: id === supported.id ? supportedMeta : legacyMeta }));
      expect(store.supportsFeedback(undefined)).toBe(true);
      expect(store.supportsFeedback(supported.id)).toBe(false);
      api.listHosts.mockResolvedValue([supported, legacy, disabled]);
      await store.load();
      expect(store.supportsFeedback(supported.id)).toBe(true);
      expect(store.supportsFeedback(legacy.id)).toBe(false);
      expect(store.supportsFeedback(disabled.id)).toBe(false);
      await store.load();
      expect(supportedMeta).toHaveBeenCalledTimes(1);
      expect(legacyMeta).toHaveBeenCalledTimes(1);
      store.applySnapshot([legacy]);
      expect(store.supportsFeedback(supported.id)).toBe(false);
    });

    it('discards stale replies when a host reconnects and refreshes support when re-enabled', async () => {
      const first = Promise.withResolvers<{ capabilities: { feedback: boolean } }>();
      remote.getMeta.mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce({ capabilities: { feedback: false } })
        .mockResolvedValueOnce({ capabilities: { feedback: true } });
      const store = hostsStore();
      const ready = host('example', { status: 'ready' });
      store.applySnapshot([ready]);
      store.applySnapshot([{ ...ready, status: 'disconnected' }]);
      api.listHosts.mockResolvedValue([ready]);
      await store.load();
      first.resolve({ capabilities: { feedback: true } });
      await first.promise;
      expect(store.supportsFeedback(ready.id)).toBe(false);
      store.applySnapshot([{ ...ready, enabled: false }]);
      await store.load();
      expect(store.supportsFeedback(ready.id)).toBe(true);
      store.applySnapshot([{ ...ready, enabled: false }]);
      expect(store.supportsFeedback(ready.id)).toBe(false);
    });

    it('recovers from a transient metadata failure without retrying a disconnected host', async () => {
      vi.useFakeTimers();
      remote.getMeta.mockRejectedValueOnce(new Error('Temporarily unavailable'))
        .mockResolvedValueOnce({ capabilities: { feedback: true } });
      const store = hostsStore();
      const ready = host('example', { status: 'ready' });
      api.listHosts.mockResolvedValue([ready]);
      await store.load();
      expect(store.supportsFeedback(ready.id)).toBe(false);
      await vi.runAllTimersAsync();
      expect(store.supportsFeedback(ready.id)).toBe(true);
      store.applySnapshot([{ ...ready, status: 'disconnected' }]);
      expect(store.supportsFeedback(ready.id)).toBe(false);
      remote.getMeta.mockRejectedValueOnce(new Error('Temporarily unavailable'));
      await store.load();
      store.applySnapshot([]);
      await vi.runAllTimersAsync();
      expect(remote.getMeta).toHaveBeenCalledTimes(3);
      expect(store.supportsFeedback(ready.id)).toBe(false);
    });
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

  it('names providers from the active host, never borrowing a local name for a remote provider', async () => {
    const models = modelsStore();
    models.setProviders([{ id: 'openai', displayName: 'My Gateway', type: 'openai', hasApiKey: true, status: 'connected' }]);
    remote.listModels.mockResolvedValue([]);
    remote.getConfig.mockResolvedValue({});
    remote.listProviders.mockResolvedValue([
      { id: 'openai', displayName: 'Remote Gateway', type: 'openai', hasApiKey: true, status: 'connected' },
    ]);
    expect(models.activeProviders.map((provider) => provider.displayName)).toEqual(['My Gateway']);

    await models.loadHostCatalog('ready');
    models.setActiveHost('ready');
    expect(models.activeProviders.map((provider) => provider.displayName)).toEqual(['Remote Gateway']);

    models.setActiveHost(undefined);
    expect(models.activeProviders.map((provider) => provider.displayName)).toEqual(['My Gateway']);
  });

  it('still loads a remote host catalog when its provider list cannot be read', async () => {
    const models = modelsStore();
    remote.listModels.mockResolvedValue([{ id: 'remote-m', model: 'remote-m', provider: 'openai' }]);
    remote.getConfig.mockResolvedValue({ defaultModel: 'remote-m' });
    remote.listProviders.mockRejectedValue(new Error('not supported'));

    await models.loadHostCatalog('ready');
    models.setActiveHost('ready');
    expect(models.activeModels.map((model) => model.id)).toEqual(['remote-m']);
    expect(models.activeProviders).toEqual([]);
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
