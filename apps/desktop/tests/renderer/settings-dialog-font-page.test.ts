// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';

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
});

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick();
}

it('grows the real Settings dialog to fit a font page and handles Escape from its focused back button', async () => {
  const { IconResolverKey } = await import('@moonshot-ai/app-ui');
  const { KimiI18nKey } = await import('@moonshot-ai/app-i18n');
  const { setKimiClientDeps } = await import('@moonshot-ai/app-client/client');
  const { clientPinia } = await import('@moonshot-ai/app-client/stores');
  const { default: i18n } = await import('../../src/renderer/i18n');
  const { default: SettingsDialog } = await import('../../src/renderer/components/settings/SettingsDialog.vue');
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
  const dialog = () => document.querySelector<HTMLElement>('.ui-dialog')!;
  const body = dialog().querySelector<HTMLElement>('.body')!;
  dialog().getBoundingClientRect = () => ({ height: 680 }) as DOMRect;
  Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 620 });
  Object.defineProperty(body, 'scrollHeight', {
    configurable: true,
    get: () => (document.querySelector('.settings-subpage') ? 900 : 620),
  });
  expect(dialog().classList.contains('settings-dialog')).toBe(true);
  expect(dialog().style.height).toBe('');
  document.querySelector<HTMLButtonElement>('[data-settings-subpage-origin="transcript"]')!.click();
  await flush();
  expect(document.querySelector('.settings-subpage')).not.toBeNull();
  const back = document.querySelector<HTMLButtonElement>('.settings-subpage-back')!;
  expect(back.closest('.settings-region-header')).not.toBeNull();
  expect(document.querySelector('.settings-subpage')?.contains(back)).toBe(false);
  expect(document.querySelectorAll('.settings-subpage-back')).toHaveLength(1);
  expect(back.textContent).toContain('Typefaces and Fonts');
  await vi.waitFor(() => expect(dialog().style.height).toBe('960px'));
  expect(document.activeElement).toBe(back);
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  back.dispatchEvent(event);
  await flush();
  expect(event.defaultPrevented).toBe(true);
  expect(document.querySelector('.settings-subpage')).toBeNull();
  expect(dialog().style.height).toBe('');
}, 60_000);

it('opens Agent & Sessions on initialTab="agent", scrolls to and highlights running send mode, and switches between Steer and Queue', async () => {
  localStorage.clear();
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });
  const { IconResolverKey } = await import('@moonshot-ai/app-ui');
  const { KimiI18nKey } = await import('@moonshot-ai/app-i18n');
  const { setKimiClientDeps } = await import('@moonshot-ai/app-client/client');
  const { useRunningSendMode } = await import('@moonshot-ai/app-client');
  const { clientPinia } = await import('@moonshot-ai/app-client/stores');
  const { default: i18n } = await import('../../src/renderer/i18n');
  const { default: SettingsDialog } = await import('../../src/renderer/components/settings/SettingsDialog.vue');
  setKimiClientDeps({ api: () => ({}), t: (key: string) => key } as never);
  useRunningSendMode().setRunningSendMode('steer');

  const host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    render: () =>
      h(SettingsDialog, {
        colorScheme: 'light',
        fontScale: 'medium',
        notify: false,
        notifySound: false,
        initialTab: 'agent',
        highlightKey: 'running-send-mode',
        onFetchUsage: async () => ({ kind: 'error' }) as never,
      }),
  });
  app.use(i18n);
  app.use(clientPinia);
  app.provide(KimiI18nKey, { t: (key: string) => key });
  app.provide(IconResolverKey, () => defineComponent({ render: () => h('svg') }));
  app.mount(host);
  await flush();

  const control = document.querySelector<HTMLElement>('[aria-label="Send while running"]')!;
  expect(control).not.toBeNull();
  const row = control.closest<HTMLElement>('.row')!;
  expect(row.getAttribute('data-setting-highlighted')).toBe('true');
  expect(row.classList.contains('row-highlighted')).toBe(true);
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  expect(scrollIntoView.mock.contexts).toContain(row);

  const tabs = [...control.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Steer', 'Queue']);
  expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');

  tabs[1]!.click();
  await flush();

  expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
  expect(useRunningSendMode().runningSendMode.value).toBe('queue');
  expect(localStorage.getItem('kimi-web.running-send-mode')).toBe('queue');

  const generalTab = [...document.querySelectorAll<HTMLButtonElement>('.settings-tab-list [role="tab"]')].find(
    (tab) => tab.textContent?.includes('General'),
  )!;
  generalTab.click();
  await flush();
  expect(row.getAttribute('data-setting-highlighted')).toBeNull();
}, 60_000);


it('exposes confirmDiscard so external shortcut or menu toggles respect unsaved tool edits', async () => {
  const { IconResolverKey } = await import('@moonshot-ai/app-ui');
  const { KimiI18nKey } = await import('@moonshot-ai/app-i18n');
  const { setKimiClientDeps } = await import('@moonshot-ai/app-client/client');
  const { useConfirmDialog } = await import('@moonshot-ai/app-client/composables');
  const { clientPinia, configStore } = await import('@moonshot-ai/app-client/stores');
  const { default: i18n } = await import('../../src/renderer/i18n');
  const { default: SettingsDialog } = await import('../../src/renderer/components/settings/SettingsDialog.vue');
  configStore().resetConfig();
  setKimiClientDeps({
    api: () => ({
      listToolCatalog: async () => [{ name: 'Bash', source: 'builtin' }],
      getConfig: async () => ({ providers: {}, tools: { disabled: [] } }),
    }),
    t: (key: string) => key,
  } as never);

  let dialogRef!: { confirmDiscard: () => Promise<boolean> };
  const host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    render: () =>
      h(SettingsDialog, {
        ref: (value) => { dialogRef = value as unknown as typeof dialogRef; },
        colorScheme: 'light',
        fontScale: 'medium',
        notify: false,
        notifySound: false,
        initialTab: 'agent',
        onFetchUsage: async () => ({ kind: 'error' }) as never,
      }),
  });
  app.use(i18n);
  app.use(clientPinia);
  app.provide(KimiI18nKey, { t: (key: string) => key });
  app.provide(IconResolverKey, () => defineComponent({ render: () => h('svg') }));
  app.mount(host);
  await flush();

  document.querySelector<HTMLButtonElement>('[data-settings-subpage-origin="tools"]')!.click();
  await vi.waitFor(() => expect(document.querySelector('.settings-subpage [role="switch"]')).not.toBeNull());
  await expect(dialogRef.confirmDiscard()).resolves.toBe(true);

  document.querySelector<HTMLButtonElement>('.settings-subpage [role="switch"]')!.click();
  await flush();

  const cancelled = dialogRef.confirmDiscard();
  await flush();
  expect(useConfirmDialog().isConfirmOpen.value).toBe(true);
  useConfirmDialog().settle(false);
  await expect(cancelled).resolves.toBe(false);

  const confirmed = dialogRef.confirmDiscard();
  await flush();
  useConfirmDialog().settle(true);
  await expect(confirmed).resolves.toBe(true);
}, 60_000);
