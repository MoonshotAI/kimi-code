// @vitest-environment jsdom
import { createApp, h, nextTick, type App, type Component } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import type { AppDevice } from '@moonshot-ai/app-core/api';
import type { RcDevice } from '@moonshot-ai/app-core/lib';
import { setKimiClientDeps, resetKimiClientDeps } from '@moonshot-ai/app-client/client';
import { useAppDialogs, useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { devicesStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import DeviceNotice from '../src/DeviceNotice.vue';
import WorkspaceIcon from '../src/WorkspaceIcon.vue';
import WorkspaceMenu from '../src/sidebar/WorkspaceMenu.vue';

const ID = 'device-a1b2c3d4';
let app: App | undefined;
let host: HTMLDivElement;

function mount(component: Component, deviceId: string, attrs: Record<string, unknown> = {}): void {
  app = createApp({ render: () => h(component, { deviceId, ...attrs }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
}

function account(id: string, extra: Partial<AppDevice> = {}): AppDevice {
  return { id, connection: 'account', alias: 'Work Mac', status: 'pending', ...extra };
}

function failedAccount(failure: AppDevice['connectFailure'], extra: Partial<AppDevice> = {}): AppDevice {
  return account('rc-mac', { status: 'disconnected', connectError: 'raw error', connectFailure: failure, ...extra });
}

function registration(clientVersion: string): RcDevice {
  return {
    device_id: 'rc-mac',
    alias: 'Work Mac',
    status: 'online',
    platform: 'darwin',
    client_version: clientVersion,
    local_base_url: '',
    created_at: '',
    updated_at: '',
    last_remote_access_at: '',
  };
}

beforeEach(() => {
  setKimiClientDeps({
    api: () => ({}) as never,
    t: (key) => key,
  });
  host = document.createElement('div');
  document.body.append(host);
  const store = devicesStore();
  store.byId = {
    [ID]: { id: ID, connection: 'ssh', host: 'build.example.test', name: 'Build box', enabled: false, status: 'pending' },
    devbox: { id: 'devbox', connection: 'ssh', host: 'dev.example.test', status: 'pending' },
  };
  store.loaded = true;
  store.focusDeviceId = null;
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  useConfirmDialog().settle(false);
  vi.restoreAllMocks();
  resetKimiClientDeps();
  const store = devicesStore();
  store.byId = {};
  store.loaded = false;
  store.accounts = {};
  store.loginDeviceId = null;
  store.focusDeviceId = null;
  store.providerCopies = {};
  store.connecting = {};
  store.settledFailures = {};
  store.registrations = null;
  store.upgradeRequests = {};
});

describe('device display names', () => {
  it('names a disabled device in the notice and jumps to the settings for that device', async () => {
    const dialogs = useAppDialogs();
    dialogs.showSettings.value = false;
    mount(DeviceNotice, ID);
    expect(host.querySelector('.device-notice-title')?.textContent).toContain('Build box');
    expect(host.textContent).not.toContain(ID);

    host.querySelector<HTMLButtonElement>('.device-notice-settings')!.click();
    await nextTick();
    expect(dialogs.showSettings.value).toBe(true);
    expect(dialogs.settingsInitialTab.value).toBe('devices');
    expect(devicesStore().focusDeviceId).toBe(ID);
    dialogs.showSettings.value = false;
  });

  it('explains a deleted device without exposing its id and offers device settings', async () => {
    mount(DeviceNotice, 'device-deleted');
    await nextTick();
    expect(host.querySelector('.device-notice-title')).not.toBeNull();
    expect(host.textContent).not.toContain('device-deleted');
    expect(host.querySelector('.device-notice-settings')).not.toBeNull();
  });

  it('leaves a ready device without models to the composer', async () => {
    devicesStore().byId = { devbox: { id: 'devbox', connection: 'ssh', host: 'dev.example.test', name: 'Build box', status: 'ready' } };
    devicesStore().accounts = { devbox: { status: 'signedOut', modelsReady: false } };
    mount(DeviceNotice, 'devbox');
    await nextTick();
    expect(host.querySelector('.device-notice')).toBeNull();
  });

  it('names the outdated remote version of an SSH device and how to upgrade it', async () => {
    devicesStore().byId = {
      devbox: {
        id: 'devbox',
        connection: 'ssh',
        host: 'dev.example.test',
        status: 'disconnected',
        remoteVersion: '0.40.0',
        connectError: "error: unknown option '--probe'",
        connectFailure: 'outdated',
      },
    };
    mount(DeviceNotice, 'devbox');
    await nextTick();

    const reason = host.querySelector<HTMLElement>('.device-notice-reason')!;
    expect(reason.textContent).toContain('kimi upgrade');
    expect(reason.title).toContain('0.40.0');
    expect(reason.title).toContain("unknown option '--probe'");
    expect(host.querySelector('.device-notice-reconnect')).not.toBeNull();
  });

  it('keeps the last failure visible while a failed device retries', async () => {
    devicesStore().byId = {
      devbox: { id: 'devbox', connection: 'ssh', host: 'dev.example.test', status: 'disconnected', connectError: 'Connection refused', connectFailure: 'connection_refused' },
    };
    mount(DeviceNotice, 'devbox');
    await nextTick();
    expect(host.querySelector('.device-notice-settings')).not.toBeNull();

    devicesStore().connecting = { devbox: true };
    await nextTick();
    expect(host.querySelector('.device-notice-title')?.textContent).toContain('Retrying');
    expect(host.querySelector('.device-notice-reason')?.textContent).toBe('Connection refused');
    expect(host.querySelector('.device-notice-reason')?.getAttribute('title')).toContain('sshd');
    expect(host.querySelector<HTMLButtonElement>('.device-notice-reconnect')?.disabled).toBe(true);
  });

  it('tells how to update an outdated account device by how it was installed', async () => {
    devicesStore().byId = { 'rc-mac': failedAccount('outdated', { remoteVersion: '1.0.0' }) };
    devicesStore().registrations = [registration('kimi-code-desktop/1.0.0')];
    mount(DeviceNotice, 'rc-mac');
    await nextTick();
    expect(host.querySelector('.device-notice-title')?.textContent).toContain('Work Mac');
    expect(host.querySelector('.device-notice-reason')?.textContent).toBe('Update Kimi Code on Work Mac, then reconnect');

    devicesStore().registrations = [registration('kimi-code-cli/1.0.0')];
    await nextTick();
    expect(host.querySelector('.device-notice-reason')?.textContent).toContain('kimi upgrade');

    devicesStore().registrations = [];
    await nextTick();
    expect(host.querySelector('.device-notice-reason')).toBeNull();
  });

  it('reports an offline account device with a way to retry now', async () => {
    devicesStore().byId = { 'rc-mac': failedAccount('offline') };
    const connect = vi.spyOn(devicesStore(), 'connect').mockResolvedValue(account('rc-mac', { status: 'ready' }));
    mount(DeviceNotice, 'rc-mac');
    await nextTick();

    expect(host.querySelector('.device-notice-title')?.textContent).toBe('Device "Work Mac" is offline');
    expect(host.querySelector('.device-notice-reason')?.textContent).toBe('Turn on "Allow other devices to control" on that device to connect');
    expect(host.querySelector('[data-icon="device-desktop"]')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('.device-notice-reconnect')!.click();
    expect(connect).toHaveBeenCalledExactlyOnceWith('rc-mac');
  });

  it('asks to sign in on this computer when the relay needs a Kimi login', async () => {
    devicesStore().byId = { 'rc-mac': failedAccount('signed_out') };
    const login = vi.fn();
    mount(DeviceNotice, 'rc-mac', { onLogin: login });
    await nextTick();

    expect(host.querySelector('.device-notice-title')?.textContent).toBe('Sign in to Kimi to connect to "Work Mac"');
    expect(host.querySelector('.device-notice-log-in')?.textContent?.trim()).toBe('Sign in');
    host.querySelector<HTMLButtonElement>('.device-notice-log-in')!.click();
    expect(login).toHaveBeenCalledOnce();
  });

  it('offers to delete a duplicate entry after confirming, naming the device it duplicates', async () => {
    devicesStore().byId = {
      'rc-mac': failedAccount('duplicate', { duplicateOf: 'devbox' }),
      devbox: { id: 'devbox', connection: 'ssh', host: 'dev.example.test', name: 'Dev box', status: 'ready' },
    };
    const remove = vi.spyOn(devicesStore(), 'remove').mockResolvedValue();
    mount(DeviceNotice, 'rc-mac');
    await nextTick();

    expect(host.querySelector('.device-notice-title')?.textContent).toBe('"Work Mac" is the same device as "Dev box"');
    host.querySelector<HTMLButtonElement>('.device-notice-delete')!.click();
    await vi.waitFor(() => expect(useConfirmDialog().current.value?.message).toContain('Dev box'));
    await useConfirmDialog().runAction();
    expect(remove).toHaveBeenCalledExactlyOnceWith('rc-mac');
  });

  it('offers to delete an entry that points at this computer', async () => {
    devicesStore().byId = { devbox: { id: 'devbox', connection: 'ssh', host: 'localhost', status: 'disconnected', connectError: 'self', connectFailure: 'self' } };
    const remove = vi.spyOn(devicesStore(), 'remove').mockResolvedValue();
    mount(DeviceNotice, 'devbox');
    await nextTick();

    expect(host.querySelector('.device-notice-title')?.textContent).toBe('"devbox" is this computer');
    host.querySelector<HTMLButtonElement>('.device-notice-delete')!.click();
    await vi.waitFor(() => expect(useConfirmDialog().current.value).not.toBeNull());
    useConfirmDialog().settle(false);
    await nextTick();
    expect(remove).not.toHaveBeenCalled();
  });

  it('describes the project icon with the device name', () => {
    mount(WorkspaceIcon, ID);
    expect(host.querySelector('.ws-icon')?.getAttribute('aria-label')).toContain('Build box');
    app!.unmount();
    mount(WorkspaceIcon, 'device-deleted');
    const deletedLabel = host.querySelector('.ws-icon')?.getAttribute('aria-label');
    expect(deletedLabel).toBeTruthy();
    expect(deletedLabel).not.toContain('device-deleted');
  });

  it('draws SSH devices as servers and account devices as computers, with their state', () => {
    devicesStore().byId = {
      devbox: { id: 'devbox', connection: 'ssh', host: 'dev.example.test', status: 'ready' },
      'rc-mac': failedAccount('offline'),
    };
    mount(WorkspaceIcon, 'devbox');
    expect(host.querySelector('[data-icon="server"]')).not.toBeNull();
    expect(host.querySelector('.ws-icon')?.getAttribute('aria-label')).toBe('devbox · Connected');
    expect(host.querySelector('.kw-dot--ok')).not.toBeNull();
    app!.unmount();

    mount(WorkspaceIcon, 'rc-mac');
    expect(host.querySelector('[data-icon="device-desktop"]')).not.toBeNull();
    expect(host.querySelector('.ws-icon')?.getAttribute('aria-label')).toBe('Work Mac · Offline');
    expect(host.querySelector('.kw-dot--idle')).not.toBeNull();
  });

  it('offers device settings in the workspace context menu and hides remote writes when the device is blocked', async () => {
    let menuInstance: { openContext: (e: MouseEvent, ws: never) => Promise<void> } | null = null;
    workspacesStore().workspaces = [
      { id: 'ws-ready', root: '/srv/a', name: 'ready-proj', kind: 'managed', deviceId: 'devbox', additionalDirs: [], sessionCount: 0 },
      { id: 'ws-broken', root: '/srv/b', name: 'broken-proj', kind: 'managed', deviceId: ID, additionalDirs: [], sessionCount: 0 },
    ];
    devicesStore().byId = {
      [ID]: { id: ID, connection: 'ssh', host: 'build.example.test', name: 'Build box', status: 'disconnected', connectError: 'refused', connectFailure: 'connection_refused' },
      devbox: { id: 'devbox', connection: 'ssh', host: 'dev.example.test', status: 'ready' },
    };

    app = createApp({
      render: () => h(WorkspaceMenu, {
        ref: (el: unknown) => { menuInstance = el as typeof menuInstance; },
        canEdit: true,
      }),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
    app.mount(host);

    await menuInstance!.openContext(new MouseEvent('contextmenu', { clientX: 10, clientY: 10 }), {
      id: 'ws-ready',
      name: 'ready-proj',
      root: '/srv/a',
      shortPath: '/srv/a',
      deviceId: 'devbox',
      additionalDirs: [],
      sessionCount: 0,
    } as never);
    await nextTick();
    expect(document.body.querySelector('.ui-menu-item.is-disabled')).toBeNull();

    await menuInstance!.openContext(new MouseEvent('contextmenu', { clientX: 10, clientY: 10 }), {
      id: 'ws-broken',
      name: 'broken-proj',
      root: '/srv/b',
      shortPath: '/srv/b',
      deviceId: ID,
      additionalDirs: [],
      sessionCount: 0,
    } as never);
    await nextTick();
    expect(document.body.textContent).not.toContain('Rename');
    expect(document.body.textContent).not.toContain('Edit project');
    document.body.querySelector<HTMLButtonElement>('.ws-menu-device-settings')!.click();
    await nextTick();
    expect(useAppDialogs().showSettings.value).toBe(true);
    expect(devicesStore().focusDeviceId).toBe(ID);
    useAppDialogs().showSettings.value = false;
    workspacesStore().workspaces = [];
  });
});

describe('device upgrade notice', () => {
  function outdatedBox(extra: Partial<AppDevice> = {}): AppDevice {
    return { id: 'devbox', connection: 'ssh', host: 'dev.example.test', status: 'disconnected', remoteVersion: '0.40.0', connectError: 'old', connectFailure: 'outdated', remoteUpgrade: true, ...extra };
  }

  it('offers to upgrade an outdated device from here instead of explaining how to do it on the device', async () => {
    devicesStore().byId = { devbox: outdatedBox() };
    const upgrade = vi.spyOn(devicesStore(), 'upgrade').mockResolvedValue();
    mount(DeviceNotice, 'devbox');
    await nextTick();

    expect(host.querySelector('.device-notice-title')?.textContent).toBe('Kimi Code on "devbox" is outdated');
    expect(host.querySelector('.device-notice-reason')).toBeNull();
    expect(host.querySelector('.device-notice-reconnect')).not.toBeNull();
    const button = host.querySelector<HTMLButtonElement>('.device-notice-upgrade')!;
    expect(button.textContent?.trim()).toBe('Upgrade');
    button.click();
    expect(upgrade).toHaveBeenCalledExactlyOnceWith('devbox');
  });

  it('keeps the desktop or CLI guidance for an outdated device that cannot be upgraded from here', async () => {
    devicesStore().byId = { 'rc-mac': failedAccount('outdated', { install: 'desktop' }) };
    mount(DeviceNotice, 'rc-mac');
    await nextTick();
    expect(host.querySelector('.device-notice-upgrade')).toBeNull();
    expect(host.querySelector('.device-notice-reason')?.textContent).toBe('Update Kimi Code on Work Mac, then reconnect');

    devicesStore().byId = { 'rc-mac': failedAccount('outdated', { install: 'cli' }) };
    await nextTick();
    expect(host.querySelector('.device-notice-reason')?.textContent).toContain('kimi upgrade');
  });

  it('shows the upgrade progress instead of any action until the device is back', async () => {
    const store = devicesStore();
    store.byId = { devbox: outdatedBox() };
    store.upgradeRequests = { devbox: true };
    mount(DeviceNotice, 'devbox');
    await nextTick();
    expect(host.querySelector('.device-notice-title')?.textContent).toBe('Upgrading Kimi Code on "devbox"…');
    expect(host.querySelector('.ui-spinner')).not.toBeNull();
    expect(host.querySelector('button')).toBeNull();

    store.upgradeRequests = {};
    store.byId = { devbox: outdatedBox({ status: 'connecting', upgradeStatus: 'restarting' }) };
    await nextTick();
    expect(host.querySelector('.device-notice-title')?.textContent).toBe('Restarting Kimi Code on "devbox"…');
    expect(host.querySelector('button')).toBeNull();

    store.byId = { devbox: { id: 'devbox', connection: 'ssh', host: 'dev.example.test', status: 'ready', remoteVersion: '1.4.0', remoteUpgrade: true } };
    await nextTick();
    expect(host.querySelector('.device-notice')).toBeNull();
  });

  it('shows why an upgrade failed with a retry while the device is still outdated', async () => {
    const store = devicesStore();
    store.byId = { devbox: outdatedBox({ upgradeStatus: 'failed', upgradeError: 'curl: (6) Could not resolve host\nexit status 6' }) };
    const upgrade = vi.spyOn(store, 'upgrade').mockResolvedValue();
    mount(DeviceNotice, 'devbox');
    await nextTick();

    expect(host.querySelector('.device-notice-title')?.textContent).toBe('Couldn\'t upgrade Kimi Code on "devbox"');
    const reason = host.querySelector<HTMLElement>('.device-notice-reason')!;
    expect(reason.textContent).toBe('curl: (6) Could not resolve host');
    expect(reason.title).toContain('exit status 6');
    expect(host.querySelector('.device-notice-reconnect')).toBeNull();
    host.querySelector<HTMLButtonElement>('.device-notice-retry')!.click();
    expect(upgrade).toHaveBeenCalledExactlyOnceWith('devbox');

    store.byId = { devbox: outdatedBox({ connectError: 'Connection refused', connectFailure: 'connection_refused', upgradeStatus: 'failed', upgradeError: 'download failed' }) };
    await nextTick();
    expect(host.querySelector('.device-notice-title')?.textContent).toBe('Can\'t connect to "devbox"');
    expect(host.querySelector('.device-notice-reconnect')).not.toBeNull();

    store.byId = { devbox: { id: 'devbox', connection: 'ssh', host: 'dev.example.test', status: 'ready', remoteUpgrade: true, upgradeStatus: 'failed', upgradeError: 'download failed' } };
    await nextTick();
    expect(host.querySelector('.device-notice')).toBeNull();
  });
});
