// @vitest-environment jsdom
import { createApp, h, nextTick, type App, type Component } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { setKimiClientDeps, resetKimiClientDeps } from '@moonshot-ai/app-client/client';
import { useAppDialogs } from '@moonshot-ai/app-client/composables';
import { hostsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import HostNotice from '../src/HostNotice.vue';
import WorkspaceIcon from '../src/WorkspaceIcon.vue';
import WorkspaceMenu from '../src/sidebar/WorkspaceMenu.vue';

const ID = 'host-a1b2c3d4';
let app: App | undefined;
let host: HTMLDivElement;

function mount(component: Component, hostId: string): void {
  app = createApp({ render: () => h(component, { hostId }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
}

beforeEach(() => {
  setKimiClientDeps({
    api: () => ({}) as never,
    t: (key) => key,
  });
  host = document.createElement('div');
  document.body.append(host);
  const store = hostsStore();
  store.byId = {
    [ID]: { id: ID, host: 'build.example.test', name: 'Build box', enabled: false, status: 'pending' },
    devbox: { id: 'devbox', host: 'dev.example.test', status: 'pending' },
  };
  store.loaded = true;
  store.focusHostId = null;
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  vi.restoreAllMocks();
  resetKimiClientDeps();
  hostsStore().byId = {};
  hostsStore().loaded = false;
  hostsStore().accounts = {};
  hostsStore().loginHostId = null;
  hostsStore().focusHostId = null;
  hostsStore().providerCopies = {};
});

describe('host display names', () => {
  it('names a disabled host in the notice and jumps to SSH settings for that host', async () => {
    const dialogs = useAppDialogs();
    dialogs.showSettings.value = false;
    mount(HostNotice, ID);
    expect(host.querySelector('.host-notice-title')?.textContent).toContain('Build box');
    expect(host.textContent).not.toContain(ID);

    host.querySelector<HTMLButtonElement>('.host-notice-settings')!.click();
    await nextTick();
    expect(dialogs.showSettings.value).toBe(true);
    expect(dialogs.settingsInitialTab.value).toBe('hosts');
    expect(hostsStore().focusHostId).toBe(ID);
    dialogs.showSettings.value = false;
  });

  it('explains a deleted host without exposing its id and offers SSH settings', async () => {
    mount(HostNotice, 'host-deleted');
    await nextTick();
    expect(host.querySelector('.host-notice-title')).not.toBeNull();
    expect(host.textContent).not.toContain('host-deleted');
    expect(host.querySelector('.host-notice-settings')).not.toBeNull();
  });

  it('leaves a ready host with no models to the model pill', async () => {
    hostsStore().byId = { devbox: { id: 'devbox', host: 'dev.example.test', name: 'Build box', status: 'ready' } };
    hostsStore().accounts = { devbox: { status: 'signedOut', modelsReady: false } };
    mount(HostNotice, 'devbox');
    await nextTick();
    expect(host.querySelector('.host-notice')).toBeNull();
  });

  it('names the outdated remote version and offers SSH settings on a failed host', async () => {
    hostsStore().byId = {
      devbox: {
        id: 'devbox',
        host: 'dev.example.test',
        status: 'disconnected',
        remoteVersion: '0.40.0',
        connectError: "error: unknown option '--probe'",
        connectFailure: 'executor_outdated',
      },
    };
    mount(HostNotice, 'devbox');
    await nextTick();

    const reason = host.querySelector<HTMLElement>('.host-notice-reason')!;
    expect(reason.textContent).toContain('0.40.0');
    expect(reason.title).toContain("unknown option '--probe'");
    expect(host.querySelector('.host-notice-reconnect')).not.toBeNull();
    expect(host.querySelector('.host-notice-settings')).not.toBeNull();

    hostsStore().connecting = { devbox: true };
    await nextTick();
    expect(host.querySelector('.host-notice-title')?.textContent).toContain('Retrying');
    expect(host.querySelector('.host-notice-reason')?.textContent).toContain('0.40.0');
    hostsStore().connecting = {};
  });

  it('describes the project icon with the host name', () => {
    mount(WorkspaceIcon, ID);
    expect(host.querySelector('.ws-icon')?.getAttribute('aria-label')).toContain('Build box');
    app!.unmount();
    mount(WorkspaceIcon, 'host-deleted');
    const deletedLabel = host.querySelector('.ws-icon')?.getAttribute('aria-label');
    expect(deletedLabel).toBeTruthy();
    expect(deletedLabel).not.toContain('host-deleted');
  });

  it('offers SSH settings in the workspace context menu and hides remote writes when the host is blocked', async () => {
    let menuInstance: { openContext: (e: MouseEvent, ws: never) => Promise<void> } | null = null;
    workspacesStore().workspaces = [
      { id: 'ws-ready', root: '/srv/a', name: 'ready-proj', kind: 'managed', hostId: 'devbox', additionalDirs: [], sessionCount: 0 },
      { id: 'ws-broken', root: '/srv/b', name: 'broken-proj', kind: 'managed', hostId: ID, additionalDirs: [], sessionCount: 0 },
    ];
    hostsStore().byId = {
      [ID]: { id: ID, host: 'build.example.test', name: 'Build box', status: 'disconnected', connectError: 'refused', connectFailure: 'connection_refused' },
      devbox: { id: 'devbox', host: 'dev.example.test', status: 'ready' },
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
      hostId: 'devbox',
      additionalDirs: [],
      sessionCount: 0,
    } as never);
    await nextTick();
    expect(document.body.textContent).toContain('Rename');
    expect(document.body.textContent).toContain('Edit project');
    expect(document.body.querySelector('.ws-menu-host-settings')).not.toBeNull();

    await menuInstance!.openContext(new MouseEvent('contextmenu', { clientX: 10, clientY: 10 }), {
      id: 'ws-broken',
      name: 'broken-proj',
      root: '/srv/b',
      shortPath: '/srv/b',
      hostId: ID,
      additionalDirs: [],
      sessionCount: 0,
    } as never);
    await nextTick();
    expect(document.body.textContent).not.toContain('Rename');
    expect(document.body.textContent).not.toContain('Edit project');
    document.body.querySelector<HTMLButtonElement>('.ws-menu-host-settings')!.click();
    await nextTick();
    expect(useAppDialogs().showSettings.value).toBe(true);
    expect(hostsStore().focusHostId).toBe(ID);
    useAppDialogs().showSettings.value = false;
    workspacesStore().workspaces = [];
  });
});
