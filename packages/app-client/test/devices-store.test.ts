import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonApiError, type AppDevice, type AppDeviceUpgradeResult } from '@moonshot-ai/app-core/api';
import type { RcDevice, RcDeviceList } from '@moonshot-ai/app-core/lib';

import { setKimiClientDeps } from '../src/client/deps';
import { authStore } from '../src/stores/auth';
import { configStore } from '../src/stores/config';
import { devicesStore, setDevicesHooks, type DevicesHooks } from '../src/stores/devices';
import { modelsStore } from '../src/stores/models';
import { warningsStore } from '../src/stores/warnings';

const api = {
  listDevices: vi.fn(),
  connectDevice: vi.fn(),
  upgradeDevice: vi.fn(),
  putDevice: vi.fn(),
  deleteDevice: vi.fn(),
  listDeviceSshConfig: vi.fn(async () => ({ configPath: '', exists: false, hosts: [] })),
  copyProvidersToDevice: vi.fn(),
  deviceApi: vi.fn(),
  listRemoteControlDevices: vi.fn(),
  renameRemoteControlDevice: vi.fn(),
  deactivateRemoteControlDevice: vi.fn(),
  deleteRemoteControlDevice: vi.fn(),
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

function storeHooks(): DevicesHooks {
  return {
    signedIn: () => authStore().signedIn,
    localDeviceId: () => configStore().deviceId,
    pushWarning: (warning) => warningsStore().pushWarning(warning),
    pushOperationFailure: warningsStore().pushOperationFailure,
  };
}

function auth(status: string | null, modelsReady = false) {
  return { modelsReady, providersCount: modelsReady ? 1 : 0, managedProvider: status === null ? null : { status } };
}

function device(id: string, extra: Partial<AppDevice> = {}): AppDevice {
  return { id, connection: 'ssh', host: `${id}.example.test`, status: 'pending', ...extra };
}

function accountDevice(id: string, extra: Partial<AppDevice> = {}): AppDevice {
  return { id, connection: 'account', status: 'pending', ...extra };
}

function registration(id: string, extra: Partial<RcDevice> = {}): RcDevice {
  return {
    device_id: id,
    alias: id,
    status: 'online',
    platform: 'darwin',
    client_version: 'kimi-code-desktop/1.3.7',
    local_base_url: 'http://127.0.0.1:58627',
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-18T00:00:00.000Z',
    last_remote_access_at: '',
    ...extra,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  for (const fn of Object.values(remote)) fn.mockReset();
  api.deviceApi.mockReturnValue(remote);
  remote.getMeta.mockResolvedValue({ capabilities: {} });
  remote.getAuth.mockResolvedValue(auth(null));
  remote.listModels.mockResolvedValue([]);
  remote.getConfig.mockResolvedValue({});
  setKimiClientDeps({ api: () => api as never, t: (key) => key });
  setDevicesHooks(storeHooks());
  authStore().managedProviderStatus = null;
  const store = devicesStore();
  store.applySnapshot([]);
  store.loaded = false;
  store.connecting = {};
  store.providerCopies = {};
  store.accounts = {};
  store.loginDeviceId = null;
  store.settledFailures = {};
  store.registrations = null;
  store.maxDevices = undefined;
  store.registrationsLoading = false;
  store.registrationsError = null;
  store.upgradeRequests = {};
  warningsStore().resetWarnings();
  configStore().deviceId = 'this-mac';
  api.listDevices.mockResolvedValue([]);
  api.listRemoteControlDevices.mockResolvedValue({ devices: [] });
});

describe('devices store', () => {
  describe('remote capabilities', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('enables local feedback and only trusts an explicit capability on each ready device', async () => {
      const store = devicesStore();
      const supported = device('supported', { status: 'ready' });
      const legacy = device('legacy', { status: 'ready' });
      const disabled = device('disabled', { status: 'ready', enabled: false });
      const supportedMeta = vi.fn().mockResolvedValue({ capabilities: { feedback: true } });
      const legacyMeta = vi.fn().mockResolvedValue({ capabilities: {}, experimentalFlags: { desktop_feedback: true } });
      api.deviceApi.mockImplementation((id: string) => ({ ...remote, getMeta: id === supported.id ? supportedMeta : legacyMeta }));
      expect(store.supportsFeedback(undefined)).toBe(true);
      expect(store.supportsFeedback(supported.id)).toBe(false);
      api.listDevices.mockResolvedValue([supported, legacy, disabled]);
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

    it('discards stale replies when a device reconnects and refreshes support when re-enabled', async () => {
      const first = Promise.withResolvers<{ capabilities: { feedback: boolean } }>();
      remote.getMeta.mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce({ capabilities: { feedback: false } })
        .mockResolvedValueOnce({ capabilities: { feedback: true } });
      const store = devicesStore();
      const ready = device('example', { status: 'ready' });
      store.applySnapshot([ready]);
      store.applySnapshot([{ ...ready, status: 'disconnected' }]);
      api.listDevices.mockResolvedValue([ready]);
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

    it('recovers from a transient metadata failure without retrying a disconnected device', async () => {
      vi.useFakeTimers();
      remote.getMeta.mockRejectedValueOnce(new Error('Temporarily unavailable'))
        .mockResolvedValueOnce({ capabilities: { feedback: true } });
      const store = devicesStore();
      const ready = device('example', { status: 'ready' });
      api.listDevices.mockResolvedValue([ready]);
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

  it('copies shareable local providers to a ready device without repeating in-flight copies and refreshes the device', async () => {
    api.copyProvidersToDevice.mockResolvedValue({ providers: ['gateway', 'backup'] });
    const store = devicesStore();
    store.applySnapshot([device('devbox', { status: 'ready' }), device('idle')]);
    await vi.waitFor(() => expect(store.accounts['devbox']?.status).toBe('signedOut'));
    remote.getAuth.mockResolvedValue(auth(null, true));

    await store.copyProviders('idle');
    expect(api.copyProvidersToDevice).not.toHaveBeenCalled();

    const pending = store.copyProviders('devbox');
    expect(store.providerCopies['devbox']).toEqual({ status: 'copying' });
    await store.copyProviders('devbox');
    await pending;
    expect(api.copyProvidersToDevice).toHaveBeenCalledExactlyOnceWith('devbox');
    expect(store.providerCopies['devbox']).toEqual({ status: 'done', result: { providers: ['gateway', 'backup'] } });
    expect(remote.listModels).toHaveBeenCalled();
    await vi.waitFor(() => expect(store.needsLogin('devbox')).toBe(false));
  });

  it('reports a failed copy and forgets the copies of removed devices', async () => {
    api.copyProvidersToDevice.mockRejectedValueOnce(new Error('boom'));
    const store = devicesStore();
    store.applySnapshot([device('devbox', { status: 'ready' })]);
    await store.copyProviders('devbox');
    expect(store.providerCopies['devbox']).toEqual({ status: 'failed' });

    store.applySnapshot([device('devbox', { status: 'disconnected' })]);
    expect(store.providerCopies['devbox']?.status).toBe('failed');
    store.applySnapshot([]);
    expect(store.providerCopies).toEqual({});
  });

  it('derives display states from the device records', async () => {
    api.listDevices.mockResolvedValue([
      device('devbox', { status: 'disconnected', connectError: 'Connection refused' }),
      device('paused', { enabled: false }),
    ]);
    const store = devicesStore();
    expect(store.displayState('devbox')).toBe('idle');
    await store.load();

    expect(store.displayState(undefined)).toBe('local');
    expect(store.displayState('devbox')).toBe('failed');
    expect(store.displayState('paused')).toBe('disabled');
    expect(store.displayState('gone')).toBe('missing');
    expect(store.unavailable('paused')).toBe(true);
    expect(store.unavailable('devbox')).toBe(false);

    store.applySnapshot([device('devbox', { status: 'ready' })]);
    expect(store.displayState('devbox')).toBe('ready');
    expect(store.displayState('paused')).toBe('missing');
  });

  it('blocks account devices that are offline, outdated, signed out, duplicated or this machine without hiding their projects', () => {
    const store = devicesStore();
    const failures = ['offline', 'outdated', 'signed_out', 'duplicate', 'self'] as const;
    store.applySnapshot(failures.map((failure) => accountDevice(failure, { status: 'disconnected', connectError: 'raw', connectFailure: failure })));

    expect(failures.map((failure) => store.displayState(failure))).toEqual(['offline', 'outdated', 'signedOut', 'duplicate', 'self']);
    expect(failures.every((failure) => store.blocked(failure))).toBe(true);
    expect(failures.some((failure) => store.unavailable(failure))).toBe(false);
  });

  it('keeps an offline device offline while the server retries it, and shows a connection it was asked for', async () => {
    let resolve!: (value: unknown) => void;
    api.connectDevice.mockReturnValue(new Promise((next) => { resolve = next; }));
    const store = devicesStore();
    store.applySnapshot([accountDevice('rc-mac', { status: 'disconnected', connectError: 'offline', connectFailure: 'offline' })]);
    store.applySnapshot([accountDevice('rc-mac', { status: 'connecting' })]);
    expect(store.displayState('rc-mac')).toBe('offline');

    const pending = store.connect('rc-mac');
    expect(store.displayState('rc-mac')).toBe('connecting');
    resolve(accountDevice('rc-mac', { status: 'ready' }));
    await pending;

    store.applySnapshot([accountDevice('rc-mac', { status: 'ready' })]);
    store.applySnapshot([accountDevice('rc-mac', { status: 'connecting' })]);
    expect(store.displayState('rc-mac')).toBe('connecting');
  });

  it('names a device by its name, then its id, and reports a removed one as unnamed', async () => {
    api.listDevices.mockResolvedValue([device('named', { name: 'Build box' }), device('devbox')]);
    expect(devicesStore().displayName('named')).toBe('');
    await devicesStore().load();
    expect(devicesStore().displayName('named')).toBe('Build box');
    expect(devicesStore().displayName('devbox')).toBe('devbox');
    expect(devicesStore().displayName('gone')).toBeUndefined();
  });

  it('reports device lifecycle transitions and notifies registered hooks', async () => {
    const store = devicesStore();
    const onDevicesChanged = vi.fn();
    setDevicesHooks({ ...storeHooks(), onDevicesChanged });
    remote.listModels.mockResolvedValue([{ id: 'remote-m', model: 'remote-m', provider: 'managed:kimi-code' }]);
    remote.getConfig.mockResolvedValue({ defaultModel: 'remote-m' });

    expect(store.applySnapshot([device('devbox'), device('ready', { status: 'ready' })])).toEqual({
      becameReady: ['ready'],
      becameDisabled: [],
      removed: [],
    });
    await modelsStore().loadDeviceCatalog('ready');
    modelsStore().setActiveDevice('ready');
    expect(modelsStore().activeModels.map((m) => m.id)).toEqual(['remote-m']);

    expect(store.applySnapshot([device('devbox', { status: 'ready' }), device('ready', { status: 'ready' })])).toEqual({
      becameReady: ['devbox'],
      becameDisabled: [],
      removed: [],
    });
    expect(store.applySnapshot([device('devbox', { status: 'disconnected', enabled: false }), device('ready', { status: 'ready' })])).toEqual({
      becameReady: [],
      becameDisabled: ['devbox'],
      removed: [],
    });
    expect(store.applySnapshot([device('devbox', { status: 'disconnected', enabled: false })])).toEqual({
      becameReady: [],
      becameDisabled: [],
      removed: ['ready'],
    });
    expect(modelsStore().activeDeviceId).toBeUndefined();
    expect(onDevicesChanged).toHaveBeenLastCalledWith({
      becameReady: [],
      becameDisabled: [],
      removed: ['ready'],
    });
  });

  it('names an account device by its latest Remote Control alias unless it has a name of its own', async () => {
    api.listRemoteControlDevices.mockResolvedValue({ devices: [registration('rc-mac', { alias: 'Renamed Mac' })] });
    const store = devicesStore();
    store.applySnapshot([accountDevice('rc-mac', { alias: 'Work Mac' }), accountDevice('rc-pc', { alias: 'Gaming PC' })]);
    expect(store.displayName('rc-mac')).toBe('Work Mac');

    await store.loadRegistrations();
    expect(store.displayName('rc-mac')).toBe('Renamed Mac');
    expect(store.displayName('rc-pc')).toBe('Gaming PC');

    store.applySnapshot([accountDevice('rc-mac', { alias: 'Work Mac', name: 'Studio' })]);
    expect(store.displayName('rc-mac')).toBe('Studio');
  });

  it('marks a device connecting until the connect request settles and does not repeat it', async () => {
    let resolve!: (value: unknown) => void;
    api.listDevices.mockResolvedValue([device('devbox')]);
    api.connectDevice.mockReturnValue(new Promise((next) => { resolve = next; }));
    const store = devicesStore();
    await store.load();
    const pending = store.connect('devbox');
    const duplicate = store.connect('devbox');

    expect(store.displayState('devbox')).toBe('connecting');
    resolve(device('devbox', { status: 'ready' }));
    await Promise.all([pending, duplicate]);
    expect(api.connectDevice).toHaveBeenCalledExactlyOnceWith('devbox');
    expect(store.connecting).toEqual({});
  });

  it('saves and removes devices through the device API and reloads the list', async () => {
    const store = devicesStore();
    await store.save('devbox', { connection: 'ssh', host: 'devbox.example.test', name: 'Dev' });
    expect(api.putDevice).toHaveBeenCalledExactlyOnceWith('devbox', { connection: 'ssh', host: 'devbox.example.test', name: 'Dev' });
    await store.remove('devbox');
    expect(api.deleteDevice).toHaveBeenCalledExactlyOnceWith('devbox');
    expect(api.listDevices).toHaveBeenCalledTimes(2);
  });

  it('reads the Kimi account of a device once it is ready and forgets it when the device drops', async () => {
    remote.getAuth.mockResolvedValue(auth('authenticated'));
    const store = devicesStore();
    store.applySnapshot([device('devbox', { status: 'ready' })]);

    await vi.waitFor(() => expect(store.accounts['devbox']).toEqual({ status: 'signedIn', modelsReady: false }));
    expect(api.deviceApi).toHaveBeenCalledWith('devbox');
    expect(store.needsLogin('devbox')).toBe(false);

    store.applySnapshot([device('devbox', { status: 'disconnected' })]);
    expect(store.accounts).toEqual({});
  });

  it('asks a signed-out device to sign in only when it has no models, and signs out on the device', async () => {
    const store = devicesStore();
    store.applySnapshot([device('devbox', { status: 'ready' })]);
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

  it('runs the login flow on the device and reloads its account and models afterwards', async () => {
    const store = devicesStore();
    store.applySnapshot([device('devbox', { status: 'ready' }), device('offline')]);
    store.openLogin('offline');
    expect(store.loginDeviceId).toBeNull();
    await expect(store.startLogin('global')).rejects.toThrow('No device is signing in');
    store.openLogin('devbox');
    expect(store.loginDeviceId).toBe('devbox');

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
    expect(store.loginDeviceId).toBeNull();
    await vi.waitFor(() => expect(store.accounts['devbox']?.status).toBe('signedIn'));
    expect(remote.listModels).toHaveBeenCalled();

    store.openLogin('devbox');
    store.applySnapshot([device('devbox', { status: 'disconnected' })]);
    expect(store.loginDeviceId).toBeNull();
  });
});

describe('devices store account devices', () => {
  it('lists my devices without this machine or machines used over SSH, online ones first', async () => {
    api.listRemoteControlDevices.mockResolvedValue({
      devices: [
        registration('rc-old', { status: 'offline' }),
        registration('this-mac'),
        registration('rc-mac'),
        registration('rc-server'),
        registration('rc-paused'),
      ],
      max_devices: 5,
    });
    const store = devicesStore();
    store.applySnapshot([
      accountDevice('rc-mac', { status: 'ready' }),
      device('devbox', { status: 'ready', deviceId: 'rc-server' }),
      device('paused', { enabled: false, deviceId: 'rc-paused' }),
      accountDevice('rc-gone', { status: 'disconnected', connectError: 'not registered', connectFailure: 'offline' }),
    ]);

    await store.loadRegistrations();

    expect(store.maxDevices).toBe(5);
    expect(store.myDevices.map((row) => [row.id, row.registration?.status, row.device?.id])).toEqual([
      ['rc-mac', 'online', 'rc-mac'],
      ['rc-paused', 'online', undefined],
      ['rc-old', 'offline', undefined],
      ['rc-gone', undefined, 'rc-gone'],
    ]);
  });

  it('adds an account device to the sidebar and connects it right away', async () => {
    api.connectDevice.mockResolvedValue(accountDevice('rc-mac', { status: 'ready' }));
    const store = devicesStore();

    await store.addAccountDevice('rc-mac');
    expect(api.putDevice).toHaveBeenCalledExactlyOnceWith('rc-mac', { connection: 'account' });
    expect(api.listDevices).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(api.connectDevice).toHaveBeenCalledExactlyOnceWith('rc-mac'));
  });

  it('renames a registration everywhere and drops a local name that would hide it', async () => {
    const store = devicesStore();
    store.applySnapshot([accountDevice('rc-mac', { name: 'Studio' }), accountDevice('rc-pc')]);

    await store.renameRegistration('rc-mac', '  Work Mac  ');
    expect(api.renameRemoteControlDevice).toHaveBeenCalledExactlyOnceWith('rc-mac', 'Work Mac');
    expect(api.putDevice).toHaveBeenCalledExactlyOnceWith('rc-mac', { connection: 'account', enabled: undefined });
    expect(api.listRemoteControlDevices).toHaveBeenCalledOnce();

    await store.renameRegistration('rc-pc', 'Gaming PC');
    expect(api.putDevice).toHaveBeenCalledOnce();
  });

  it('takes a registration offline, and deletes one from the account together with its sidebar entry', async () => {
    const store = devicesStore();
    store.applySnapshot([accountDevice('rc-mac'), device('devbox')]);

    await store.deactivateRegistration('rc-mac');
    expect(api.deactivateRemoteControlDevice).toHaveBeenCalledExactlyOnceWith('rc-mac');
    expect(api.deleteDevice).not.toHaveBeenCalled();

    await store.deleteRegistration('rc-old');
    expect(api.deleteRemoteControlDevice).toHaveBeenCalledExactlyOnceWith('rc-old');
    expect(api.deleteDevice).not.toHaveBeenCalled();

    await store.deleteRegistration('rc-mac');
    expect(api.deleteDevice).toHaveBeenCalledExactlyOnceWith('rc-mac');
    expect(api.listRemoteControlDevices).toHaveBeenCalledTimes(3);
  });

  it('keeps the newest registration list when an older request lands last, and reports failures', async () => {
    const first = deferred<RcDeviceList>();
    const second = deferred<RcDeviceList>();
    api.listRemoteControlDevices.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = devicesStore();

    const older = store.loadRegistrations();
    const newer = store.loadRegistrations();
    second.resolve({ devices: [registration('rc-mac', { alias: 'Newest' })] });
    await newer;
    first.resolve({ devices: [registration('rc-mac', { alias: 'Stale' })] });
    await older;
    expect(store.registrations?.[0]?.alias).toBe('Newest');
    expect(store.registrationsLoading).toBe(false);

    api.listRemoteControlDevices.mockRejectedValueOnce(new Error('relay down'));
    await store.loadRegistrations();
    expect(store.registrationsError).toBe('relay down');
    expect(store.registrations?.[0]?.alias).toBe('Newest');
  });

  it('looks up how an outdated account device was installed once this machine is signed in', async () => {
    api.listRemoteControlDevices.mockResolvedValue({
      devices: [registration('rc-mac'), registration('rc-box', { client_version: 'kimi-code-cli/1.0.0' })],
    });
    const store = devicesStore();
    const outdated = [
      accountDevice('rc-mac', { status: 'disconnected', connectError: 'old', connectFailure: 'outdated' }),
      accountDevice('rc-box', { status: 'disconnected', connectError: 'old', connectFailure: 'outdated' }),
      device('devbox'),
    ];
    store.applySnapshot(outdated);
    expect(api.listRemoteControlDevices).not.toHaveBeenCalled();

    authStore().managedProviderStatus = 'authenticated';
    store.applySnapshot(outdated);
    await vi.waitFor(() => expect(store.registrations).not.toBeNull());
    expect(api.listRemoteControlDevices).toHaveBeenCalledOnce();
    expect(store.install('rc-mac')).toBe('desktop');
    expect(store.install('rc-box')).toBe('cli');
    expect(store.install('devbox')).toBe('cli');
    expect(store.install('gone')).toBeUndefined();
    authStore().managedProviderStatus = null;
  });

  it('reconnects account devices that waited for this machine to log in and forgets the account when it logs out', async () => {
    api.connectDevice.mockResolvedValue(accountDevice('rc-mac', { status: 'ready' }));
    api.listRemoteControlDevices.mockResolvedValue({ devices: [registration('rc-mac')], max_devices: 3 });
    const store = devicesStore();
    store.applySnapshot([
      accountDevice('rc-mac', { status: 'disconnected', connectError: 'login required', connectFailure: 'signed_out' }),
      accountDevice('rc-pc', { status: 'disconnected', connectError: 'offline', connectFailure: 'offline' }),
      device('devbox', { status: 'disconnected', connectError: 'refused', connectFailure: 'connection_refused' }),
    ]);
    await store.loadRegistrations();

    authStore().managedProviderStatus = 'authenticated';
    await nextTick();
    await vi.waitFor(() => expect(api.connectDevice).toHaveBeenCalledExactlyOnceWith('rc-mac'));

    authStore().managedProviderStatus = null;
    await nextTick();
    expect(store.registrations).toBeNull();
    expect(store.maxDevices).toBeUndefined();
  });
});

describe('devices store remote upgrades', () => {
  const outdated = { status: 'disconnected', connectError: 'old', connectFailure: 'outdated', remoteUpgrade: true } as const;

  function toasts(): (string | undefined)[][] {
    return warningsStore().warnings.map(({ severity, title, message }) => [severity, title, message]);
  }

  beforeEach(() => {
    setKimiClientDeps({
      api: () => api as never,
      t: (key, params) => (typeof params?.['name'] === 'string' ? `${key}(${params['name']})` : key),
    });
  });

  it('offers an upgrade only for devices that can be upgraded from here and are not busy', () => {
    const store = devicesStore();
    store.applySnapshot([
      device('ready-box', { status: 'ready', remoteUpgrade: true }),
      device('old-box', outdated),
      device('paused', { enabled: false, remoteUpgrade: true }),
      device('busy', { status: 'ready', remoteUpgrade: true, upgradeStatus: 'installing' }),
      accountDevice('rc-desktop', { status: 'disconnected', connectError: 'old', connectFailure: 'outdated', install: 'desktop' }),
      accountDevice('rc-offline', { status: 'disconnected', connectError: 'offline', connectFailure: 'offline', remoteUpgrade: true }),
    ]);

    const ids = ['ready-box', 'old-box', 'paused', 'busy', 'rc-desktop', 'rc-offline', 'gone'];
    expect(ids.filter((id) => store.canUpgrade(id))).toEqual(['ready-box', 'old-box']);
    expect(store.canUpgrade(undefined)).toBe(false);
  });

  it('shows an upgrade as installing until the server reports its progress, without sending it twice', async () => {
    const started = deferred<AppDeviceUpgradeResult>();
    api.upgradeDevice.mockReturnValue(started.promise);
    api.listDevices.mockResolvedValue([device('devbox', { ...outdated, upgradeStatus: 'installing' })]);
    const store = devicesStore();
    store.applySnapshot([device('devbox', { ...outdated, upgradeStatus: 'failed', upgradeError: 'download failed' })]);
    expect(store.upgradeStatus('devbox')).toBe('failed');
    expect(store.canUpgrade('devbox')).toBe(true);

    const pending = store.upgrade('devbox');
    const duplicate = store.upgrade('devbox');
    expect(store.upgradeStatus('devbox')).toBe('installing');
    expect(store.canUpgrade('devbox')).toBe(false);
    started.resolve({ status: 'started' });
    await Promise.all([pending, duplicate]);

    expect(api.upgradeDevice).toHaveBeenCalledExactlyOnceWith('devbox');
    expect(api.listDevices).toHaveBeenCalledOnce();
    expect(store.upgradeRequests).toEqual({});
    expect(store.upgradeStatus('devbox')).toBe('installing');
    expect(toasts()).toEqual([]);

    store.applySnapshot([device('devbox', { status: 'connecting', remoteUpgrade: true, upgradeStatus: 'restarting' })]);
    expect(store.upgradeStatus('devbox')).toBe('restarting');
    store.applySnapshot([device('devbox', { status: 'ready', remoteVersion: '1.4.0', remoteUpgrade: true })]);
    expect(store.upgradeStatus('devbox')).toBeUndefined();
    expect(store.canUpgrade('devbox')).toBe(true);

    const again = deferred<AppDeviceUpgradeResult>();
    api.upgradeDevice.mockReturnValue(again.promise);
    const retry = store.upgrade('devbox');
    store.applySnapshot([device('devbox', { status: 'ready', remoteUpgrade: true, upgradeStatus: 'installing' })]);
    again.resolve({ status: 'started' });
    await retry;
    expect(api.listDevices).toHaveBeenCalledOnce();
  });

  it('tells how to update a device that cannot be upgraded from here instead of reporting an error', async () => {
    api.upgradeDevice.mockResolvedValueOnce({ status: 'update_on_device' }).mockResolvedValueOnce({ status: 'unsupported' });
    const store = devicesStore();
    store.applySnapshot([accountDevice('rc-mac', { status: 'ready', alias: 'Work Mac', remoteUpgrade: true })]);

    await store.upgrade('rc-mac');
    await store.upgrade('rc-mac');

    expect(toasts()).toEqual([
      ['info', 'workspace.deviceUpgrade.updateOnDevice(Work Mac)', undefined],
      ['info', 'workspace.deviceUpgrade.unsupported(Work Mac)', undefined],
    ]);
    expect(api.listDevices).not.toHaveBeenCalled();
    expect(store.upgradeStatus('rc-mac')).toBeUndefined();
  });

  it('reports a failed upgrade request in a short toast and follows an upgrade that is already running', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.upgradeDevice
      .mockRejectedValueOnce(new DaemonApiError({ code: 40420, msg: 'device "devbox" is not configured', requestId: 'r1' }))
      .mockRejectedValueOnce(new DaemonApiError({ code: 40926, msg: 'device "devbox" is offline', requestId: 'r2' }))
      .mockRejectedValueOnce(new DaemonApiError({ code: 50000, msg: 'installer crashed', requestId: 'r3' }))
      .mockRejectedValueOnce(new DaemonApiError({ code: 40936, msg: 'an upgrade is already running', requestId: 'r4' }));
    api.listDevices.mockResolvedValue([device('devbox', { status: 'ready', name: 'Dev box', remoteUpgrade: true, upgradeStatus: 'installing' })]);
    const store = devicesStore();
    store.applySnapshot([device('devbox', { status: 'ready', name: 'Dev box', remoteUpgrade: true })]);

    for (let attempt = 0; attempt < 4; attempt++) await store.upgrade('devbox');

    expect(toasts()).toEqual([
      ['error', 'workspace.deviceNotice.upgradeFailed(Dev box)', 'workspace.deviceUpgrade.removed'],
      ['error', 'workspace.deviceNotice.upgradeFailed(Dev box)', 'workspace.deviceUpgrade.unavailable'],
      ['error', 'workspace.deviceNotice.upgradeFailed(Dev box)', 'installer crashed'],
      ['info', 'workspace.deviceUpgrade.inProgress(Dev box)', undefined],
    ]);
    expect(api.listDevices).toHaveBeenCalledOnce();
    expect(store.upgradeStatus('devbox')).toBe('installing');
    consoleError.mockRestore();
  });

  it('takes how a device was installed from its snapshot and refreshes the account devices after an upgrade', async () => {
    authStore().managedProviderStatus = 'authenticated';
    const store = devicesStore();
    const box = accountDevice('rc-box', { install: 'cli', remoteUpgrade: true });
    store.applySnapshot([{ ...box, ...outdated, upgradeStatus: 'installing' }]);
    expect(store.install('rc-box')).toBe('cli');

    store.applySnapshot([{ ...box, status: 'connecting', upgradeStatus: 'restarting' }]);
    expect(api.listRemoteControlDevices).not.toHaveBeenCalled();
    store.applySnapshot([{ ...box, status: 'ready', remoteVersion: '1.4.0' }]);
    await vi.waitFor(() => expect(api.listRemoteControlDevices).toHaveBeenCalledOnce());
    authStore().managedProviderStatus = null;
  });
});
