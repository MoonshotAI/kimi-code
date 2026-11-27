// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon, type IconName } from '@moonshot-ai/app-client/icons';
import { setKimiClientDeps, resetKimiClientDeps, onToast, type ToastEvent } from '@moonshot-ai/app-client/client';
import {
  __resetMcpAuthorizationForTests,
  __resetPluginsForTests,
  useMcpAuthorization,
  usePlugins,
} from '@moonshot-ai/app-client/composables';
import type {
  AppMcpAuthStatus,
  AppPluginCapabilities,
  AppPluginMarketplaceEntry,
  AppPluginSummary,
} from '@moonshot-ai/app-core/api';

vi.mock('@moonshot-ai/app-client/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/client')>();
  return { ...actual, connectEventsIfNeeded: vi.fn() };
});

import PluginsPanel from '../src/settings/PluginsPanel.vue';

const catalogEntry: AppPluginMarketplaceEntry = {
  id: 'kuaishan',
  tier: 'official',
  displayName: '快闪',
  shortDescription: '快闪知识库与文档问答能力。',
  version: '1.0.0',
  source: 'kuaishan.zip',
};

const capabilities: AppPluginCapabilities = {
  skills: [],
  mcpServers: [{
    name: 'kuaishan',
    displayName: '快闪',
    description: '快闪官方 MCP 服务。',
    runtimeName: 'plugin-kuaishan:kuaishan',
    enabled: true,
    transport: 'http',
    url: 'https://mcp.example.test/kuaishan',
  }],
};

function summary(): AppPluginSummary {
  return {
    id: 'kuaishan',
    catalogId: 'kuaishan',
    displayName: '快闪',
    version: '1.0.0',
    enabled: true,
    state: 'ok',
    skillCount: 0,
    mcpServerCount: 1,
    enabledMcpServerCount: 1,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'kuaishan.zip',
    origin: 'marketplace',
    installedAt: '2026-11-26T10:00:00Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await nextTick();
}

describe('PluginsPanel reinstall authorization wiring', () => {
  let app: App | null = null;
  let host: HTMLDivElement;
  let installed: boolean;
  let authorized: boolean;
  let inspectCalls: number;
  let reinstallInspection: ReturnType<typeof deferred<AppMcpAuthStatus[]>>;
  let toasts: ToastEvent[];
  let stopToastListener: (() => void) | undefined;

  const apiMock = {
    listPluginMarketplace: vi.fn(async (): Promise<AppPluginMarketplaceEntry[]> => [
      { ...catalogEntry, installed },
    ]),
    listPlugins: vi.fn(async (): Promise<AppPluginSummary[]> => (installed ? [summary()] : [])),
    listCapabilities: vi.fn(async () => []),
    getPluginInfo: vi.fn(async (): Promise<AppPluginCapabilities> => capabilities),
    previewPlugin: vi.fn(async (): Promise<AppPluginCapabilities> => capabilities),
    installPlugin: vi.fn(async (): Promise<AppPluginSummary> => {
      installed = true;
      return summary();
    }),
    removePlugin: vi.fn(async (): Promise<{ ok: true }> => {
      installed = false;
      authorized = false;
      return { ok: true };
    }),
    setPluginEnabled: vi.fn(async (): Promise<{ ok: true }> => ({ ok: true })),
    getMcpAuthStatuses: vi.fn(async (): Promise<AppMcpAuthStatus[]> => [{
      name: 'plugin-kuaishan:kuaishan',
      authStatus: authorized ? 'oauth-authorized' : 'not-applicable',
    }]),
    inspectMcpAuthStatuses: vi.fn((): Promise<AppMcpAuthStatus[]> => {
      inspectCalls += 1;
      if (inspectCalls > 1) return reinstallInspection.promise;
      return Promise.resolve([{
        name: 'plugin-kuaishan:kuaishan',
        authStatus: authorized ? 'oauth-authorized' : 'oauth-required',
      }]);
    }),
    beginMcpAuth: vi.fn(async () => ({
      status: 'authorization-required' as const,
      flowId: 'flow-kuaishan',
      authorizationUrl: 'https://auth.example.test/authorize',
    })),
    completeMcpAuth: vi.fn(() => new Promise<null>(() => {})),
    cancelMcpAuth: vi.fn(async () => null),
    resetMcpAuth: vi.fn(async () => null),
  };

  beforeEach(() => {
    __resetPluginsForTests();
    __resetMcpAuthorizationForTests();
    const plugins = usePlugins();
    plugins.state.entries = [];
    plugins.state.installed = [];
    plugins.state.capabilities = [];
    plugins.state.loaded = false;
    plugins.state.loading = false;
    plugins.state.error = null;
    plugins.state.catalogError = null;
    plugins.state.busy = {};
    plugins.state.rowErrors = {};

    installed = true;
    authorized = true;
    inspectCalls = 0;
    toasts = [];
    reinstallInspection = deferred<AppMcpAuthStatus[]>();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stopToastListener = onToast((event) => {
      if (event.type === 'show') toasts.push(event);
    });
    vi.clearAllMocks();
    const i18n = createKimiI18n({ locale: 'zh' });
    setKimiClientDeps({
      api: () => apiMock as never,
      t: (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params)),
    });
    vi.spyOn(window, 'open').mockReturnValue({
      closed: false,
      opener: null,
      location: { href: '' },
      close: vi.fn(),
    } as unknown as Window);

    host = document.createElement('div');
    document.body.append(host);
    app = createApp({ render: () => h(PluginsPanel) });
    app.use(i18n);
    app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
    app.mount(host);
  });

  afterEach(() => {
    stopToastListener?.();
    stopToastListener = undefined;
    app?.unmount();
    app = null;
    host.remove();
    document.body.innerHTML = '';
    __resetMcpAuthorizationForTests();
    resetKimiClientDeps();
    vi.restoreAllMocks();
  });

  it('runs real remove and install actions without flashing stale authorization before auto OAuth starts', async () => {
    await settle();
    host.querySelector<HTMLButtonElement>('[data-plugin-row="kuaishan"]')!.click();
    await settle();

    const details = () => host.querySelector<HTMLElement>('.plugin-details')!;
    const badge = () => details().querySelector('.plugin-capabilities__identity .ui-badge');
    expect(badge()?.textContent).toBe('已授权');
    expect(useMcpAuthorization().states['plugin-kuaishan:kuaishan']?.status).toBe('oauth-authorized');

    details().querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click();
    await nextTick();
    document.querySelector<HTMLElement>('.plugin-actions__menu .ui-menu-item')!.click();
    await nextTick();
    document.querySelector<HTMLButtonElement>('.confirm-dialog__confirm')!.click();
    await settle();

    expect(apiMock.removePlugin).toHaveBeenCalledWith('kuaishan');
    expect(authorized).toBe(false);
    expect(details().querySelector<HTMLButtonElement>('.plugin-actions .ui-button')?.textContent).toBe('安装');
    expect(badge()).toBeNull();

    const renderedTexts: string[] = [];
    const observer = new MutationObserver(() => {
      renderedTexts.push(details().textContent ?? '');
    });
    observer.observe(details(), { childList: true, subtree: true, characterData: true });

    details().querySelector<HTMLButtonElement>('.plugin-actions .ui-button')!.click();
    await settle();

    expect(apiMock.installPlugin).toHaveBeenCalledTimes(1);
    expect(details().querySelector('.plugin-capabilities__loading')?.textContent).toBe('加载中');
    expect(badge()).toBeNull();
    for (const text of renderedTexts) {
      expect(text).not.toContain('已授权');
    }

    reinstallInspection.resolve([{ name: 'plugin-kuaishan:kuaishan', authStatus: 'oauth-required' }]);
    await settle();
    observer.disconnect();

    expect(apiMock.beginMcpAuth).toHaveBeenCalledWith({
      source: 'plugin',
      pluginId: 'kuaishan',
      serverName: 'kuaishan',
    });
    expect(details().querySelector('.plugin-capabilities__actions')?.textContent).toContain('等待授权…');
    expect(badge()).toBeNull();
    for (const text of renderedTexts) {
      expect(text).not.toContain('已授权');
    }
  });

  it('shows a transient toast and no inline error row when beginning authorization fails', async () => {
    authorized = false;
    apiMock.beginMcpAuth.mockRejectedValueOnce(new Error('OAuth service unavailable'));
    await settle();

    host.querySelector<HTMLButtonElement>('[data-plugin-row="kuaishan"]')!.click();
    await settle();
    const details = () => host.querySelector<HTMLElement>('.plugin-details')!;
    const actionButton = () => details().querySelector<HTMLButtonElement>('.plugin-capabilities__actions button')!;
    expect(actionButton().textContent).toBe('授权');

    actionButton().click();
    await settle();

    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.options).toEqual({
      layout: 'bar',
      mode: 'replace',
      variant: 'danger',
      title: '授权失败，请稍后重试',
      duration: 5_000,
    });
    expect(toasts[0]?.options?.message).toBeUndefined();
    expect(details().querySelector('.plugin-capabilities__item [role="alert"]')).toBeNull();
    expect(actionButton().textContent).toBe('授权');

    details().querySelector<HTMLButtonElement>('[aria-label="返回"]')!.click();
    await settle();
    host.querySelector<HTMLButtonElement>('[data-plugin-row="kuaishan"]')!.click();
    reinstallInspection.resolve([{ name: 'plugin-kuaishan:kuaishan', authStatus: 'oauth-required' }]);
    await settle();

    expect(toasts).toHaveLength(1);
    expect(details().querySelector('.plugin-capabilities__item [role="alert"]')).toBeNull();
    expect(actionButton().textContent).toBe('授权');
  });

  it('shows a transient toast and keeps the authorized row clean when resetting authorization fails', async () => {
    apiMock.resetMcpAuth.mockRejectedValueOnce(new Error('reset failed'));
    await settle();

    host.querySelector<HTMLButtonElement>('[data-plugin-row="kuaishan"]')!.click();
    await settle();
    const details = () => host.querySelector<HTMLElement>('.plugin-details')!;
    expect(details().querySelector('.plugin-capabilities__identity .ui-badge')?.textContent).toBe('已授权');

    details().querySelector<HTMLButtonElement>('.plugin-capabilities__actions button')!.click();
    await nextTick();
    document.querySelector<HTMLButtonElement>('.confirm-dialog__confirm')!.click();
    await settle();

    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.options).toEqual({
      layout: 'bar',
      mode: 'replace',
      variant: 'danger',
      title: '取消授权失败，请稍后重试',
      duration: 5_000,
    });
    expect(toasts[0]?.options?.message).toBeUndefined();
    expect(details().querySelector('.plugin-capabilities__identity .ui-badge')?.textContent).toBe('已授权');
    expect(details().querySelector('.plugin-capabilities__item [role="alert"]')).toBeNull();

    details().querySelector<HTMLButtonElement>('[aria-label="返回"]')!.click();
    await settle();
    host.querySelector<HTMLButtonElement>('[data-plugin-row="kuaishan"]')!.click();
    reinstallInspection.resolve([{ name: 'plugin-kuaishan:kuaishan', authStatus: 'oauth-authorized' }]);
    await settle();

    expect(toasts).toHaveLength(1);
    expect(details().querySelector('.plugin-capabilities__item [role="alert"]')).toBeNull();
  });

  it('keeps the status refresh failure banner with retry and does not toast', async () => {
    apiMock.inspectMcpAuthStatuses.mockRejectedValueOnce(new Error('status unavailable'));
    await settle();

    host.querySelector<HTMLButtonElement>('[data-plugin-row="kuaishan"]')!.click();
    await settle();
    const details = () => host.querySelector<HTMLElement>('.plugin-details')!;
    const banner = () => details().querySelector<HTMLElement>('.plugin-capabilities__error');
    expect(banner()?.textContent).toContain('status unavailable');
    expect(toasts).toHaveLength(0);

    banner()!.querySelector<HTMLButtonElement>('button')!.click();
    reinstallInspection.resolve([{ name: 'plugin-kuaishan:kuaishan', authStatus: 'oauth-authorized' }]);
    await settle();

    expect(banner()).toBeNull();
    expect(details().querySelector('.plugin-capabilities__identity .ui-badge')?.textContent).toBe('已授权');
    expect(toasts).toHaveLength(0);
  });
});
