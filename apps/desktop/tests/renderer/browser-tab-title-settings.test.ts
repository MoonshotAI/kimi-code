// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { STORAGE_KEYS } from '@moonshot-ai/app-core/lib';

vi.mock('@moonshot-ai/app-markdown', () => ({
  Markdown: defineComponent({ render: () => h('div') }),
  HistoryImageCacheKey: Symbol('HistoryImageCache'),
  createHistoryImageCache: () => ({}),
}));

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick();
}

describe('BrowserTabTitleSetting placement and interactions', () => {
  it('hides BrowserTabTitleSetting inside the Electron desktop shell', async () => {
    vi.stubGlobal('kimiDesktop', {
      onUpdateStatus: () => () => {},
      getUpdateStatus: async () => ({ state: 'idle' }),
    });
    const { IconResolverKey } = await import('@moonshot-ai/app-ui');
    const { KimiI18nKey } = await import('@moonshot-ai/app-i18n');
    const { setKimiClientDeps } = await import('@moonshot-ai/app-client/client');
    const { clientPinia } = await import('@moonshot-ai/app-client/stores');
    const { default: i18n } = await import('../../src/renderer/i18n');
    const { default: SettingsDialog } = await import(
      '../../src/renderer/components/settings/SettingsDialog.vue'
    );
    setKimiClientDeps({ api: () => ({}), t: (key: string) => key } as never);

    const host = document.createElement('div');
    document.body.append(host);
    app = createApp({
      render: () =>
        h(SettingsDialog, {
          colorScheme: 'light',
          fontScale: 'medium',
          notify: false,
          notifySound: false,
          onFetchUsage: async () => ({ kind: 'error' }) as never,
        }),
    });
    app.use(i18n);
    app.use(clientPinia);
    app.provide(KimiI18nKey, { t: (key: string) => key });
    app.provide(IconResolverKey, () => defineComponent({ render: () => h('svg') }));
    app.mount(host);
    await flush();

    expect(document.querySelector('.bt-setting')).toBeNull();
  }, 60_000);

  it('renders under General -> Appearance in browser pages and updates preview + localStorage on toggle/reorder', async () => {
    vi.stubGlobal('kimiDesktop', undefined);
    const { IconResolverKey } = await import('@moonshot-ai/app-ui');
    const { KimiI18nKey } = await import('@moonshot-ai/app-i18n');
    const { setKimiClientDeps } = await import('@moonshot-ai/app-client/client');
    const { useBrowserTabTitle } = await import('@moonshot-ai/app-client/composables');
    const { clientPinia } = await import('@moonshot-ai/app-client/stores');
    const { default: i18n } = await import('../../src/renderer/i18n');
    const { default: SettingsDialog } = await import(
      '../../src/renderer/components/settings/SettingsDialog.vue'
    );
    setKimiClientDeps({ api: () => ({}), t: (key: string) => key } as never);
    useBrowserTabTitle().reloadBrowserTabTitle();

    const host = document.createElement('div');
    document.body.append(host);
    app = createApp({
      render: () =>
        h(SettingsDialog, {
          colorScheme: 'light',
          fontScale: 'medium',
          notify: false,
          notifySound: false,
          onFetchUsage: async () => ({ kind: 'error' }) as never,
        }),
    });
    app.use(i18n);
    app.use(clientPinia);
    app.provide(KimiI18nKey, { t: (key: string) => key });
    app.provide(IconResolverKey, () => defineComponent({ render: () => h('svg') }));
    app.mount(host);
    await flush();

    const setting = document.querySelector<HTMLElement>('.bt-setting')!;
    expect(setting).not.toBeNull();
    expect(setting.querySelector('.bt-state-pill')).toBeNull();
    expect(setting.querySelector('.bt-chrome-strip')).toBeNull();
    expect(setting.querySelector('.bt-row + .bt-preview')).not.toBeNull();
    expect(setting.querySelectorAll('.bt-preview-tab')).toHaveLength(1);
    const previewText = () =>
      setting.querySelector<HTMLElement>('.bt-preview-title')?.textContent?.trim();
    expect(previewText()).toBe('kimi-code-app · Fix the flaky login test');

    const chips = () => [...setting.querySelectorAll<HTMLButtonElement>('.bt-chip')];
    expect(chips().map((c) => c.dataset['reorderId'])).toEqual(['workspace', 'session']);

    chips()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flush();
    expect(chips().map((c) => c.dataset['reorderId'])).toEqual(['session', 'workspace']);
    expect(previewText()).toBe('Fix the flaky login test · kimi-code-app');

    chips()[1]!.click();
    await flush();
    expect(chips()[1]!.getAttribute('aria-checked')).toBe('false');
    expect(previewText()).toBe('Fix the flaky login test');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.browserTabTitle)!)).toEqual([
      { id: 'session', enabled: true },
      { id: 'workspace', enabled: false },
    ]);
  }, 60_000);
});
