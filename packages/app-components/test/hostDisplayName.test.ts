// @vitest-environment jsdom
import { createApp, h, nextTick, type App, type Component } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { hostsStore } from '@moonshot-ai/app-client/stores';
import HostNotice from '../src/HostNotice.vue';
import WorkspaceIcon from '../src/WorkspaceIcon.vue';

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
  host = document.createElement('div');
  document.body.append(host);
  const store = hostsStore();
  store.byId = {
    [ID]: { id: ID, host: 'build.example.test', name: 'Build box', enabled: false, status: 'pending' },
    devbox: { id: 'devbox', host: 'dev.example.test', status: 'pending' },
  };
  store.loaded = true;
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  vi.restoreAllMocks();
  hostsStore().byId = {};
  hostsStore().loaded = false;
  hostsStore().accounts = {};
  hostsStore().loginHostId = null;
  hostsStore().providerCopies = {};
});

describe('host display names', () => {
  it('names a disabled host in the notice without a host-management action', () => {
    mount(HostNotice, ID);
    expect(host.querySelector('.host-notice-title')?.textContent).toContain('Build box');
    expect(host.textContent).not.toContain(ID);
    expect(host.querySelector('button')).toBeNull();
  });

  it('explains a deleted host without exposing its id or offering an action', async () => {
    mount(HostNotice, 'host-deleted');
    await nextTick();
    expect(host.querySelector('.host-notice-title')).not.toBeNull();
    expect(host.textContent).not.toContain('host-deleted');
    expect(host.querySelector('button')).toBeNull();
  });

  it('offers both ways to get models on a ready host that has none', async () => {
    hostsStore().byId = { devbox: { id: 'devbox', host: 'dev.example.test', name: 'Build box', status: 'ready' } };
    hostsStore().accounts = { devbox: { status: 'signedOut', modelsReady: true } };
    mount(HostNotice, 'devbox');
    await nextTick();
    expect(host.querySelector('.host-notice')).toBeNull();

    hostsStore().accounts = { devbox: { status: 'signedOut', modelsReady: false } };
    await nextTick();
    expect(host.querySelector('.host-notice-title')?.textContent).toContain('Build box');
    host.querySelector<HTMLButtonElement>('.host-notice-sign-in')!.click();
    expect(hostsStore().loginHostId).toBe('devbox');
    const copy = vi.spyOn(hostsStore(), 'copyProviders').mockResolvedValue();
    host.querySelector<HTMLButtonElement>('.host-notice-use-local')!.click();
    await vi.waitFor(() => expect(useConfirmDialog().current.value?.title).toContain('Build box'));
    expect(useConfirmDialog().current.value?.message).toBeTruthy();
    useConfirmDialog().settle(true);
    await vi.waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith('devbox'));
  });

  it('names the outdated remote version in the notice', async () => {
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
});
