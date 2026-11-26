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

it('groups and filters archived sessions by project under its name, and by session directory when the project is not listed', async () => {
  const { IconResolverKey } = await import('@moonshot-ai/app-ui');
  const { KimiI18nKey } = await import('@moonshot-ai/app-i18n');
  const { setKimiClientDeps } = await import('@moonshot-ai/app-client/client');
  const { clientPinia, workspacesStore } = await import('@moonshot-ai/app-client/stores');
  const { default: i18n } = await import('../../src/renderer/i18n');
  const { default: SettingsDialog } = await import('../../src/renderer/components/settings/SettingsDialog.vue');
  const archived = (title: string, workspaceId: string, cwd: string) => ({
    id: title, title, workspaceId, cwd, archived: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const items = [
    archived('in a worktree', 'wd_app', '/code/app-fix'),
    archived('in a removed project', 'wd_gone', '/code/gone'),
    archived('in the main checkout', 'wd_app', '/code/app'),
  ];
  setKimiClientDeps({ api: () => ({ listSessions: async () => ({ items }) }), t: (key: string) => key } as never);
  workspacesStore().workspaces = [
    { id: 'wd_app', root: '/code/app', name: 'My app', kind: 'implicit', additionalDirs: [], sessionCount: 0 },
  ];

  const host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    render: () =>
      h(SettingsDialog, {
        colorScheme: 'light',
        fontScale: 'medium',
        notify: false,
        notifySound: false,
        initialTab: 'archived',
        onFetchUsage: async () => ({ kind: 'error' }) as never,
      }),
  });
  app.use(i18n);
  app.use(clientPinia);
  app.provide(KimiI18nKey, { t: (key: string) => key });
  app.provide(IconResolverKey, () => defineComponent({ render: () => h('svg') }));
  app.mount(host);
  const text = (element: Element | null) => element?.textContent?.trim();
  const groups = () => [...document.querySelectorAll('.archive-card')].map((card) => [
    [...card.querySelectorAll('.archive-workspace .path')].map(text),
    [...card.querySelectorAll('.archive-name')].map(text),
  ]);

  await vi.waitFor(() => expect(groups()).toEqual([
    [['My app', '/code/app'], ['in a worktree', 'in the main checkout']],
    [['/code/gone'], ['in a removed project']],
  ]));

  document.querySelector<HTMLButtonElement>('.archive-toolbar [role="combobox"]')!.click();
  await flush();
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options.map(text).slice(1)).toEqual(['/code/gone', 'My app/code/app']);
  options.find((option) => text(option) === 'My app/code/app')!.click();
  await flush();

  expect(groups()).toEqual([[['My app', '/code/app'], ['in a worktree', 'in the main checkout']]]);
  workspacesStore().workspaces = [];
}, 60_000);

it('shows each archived project path beside its name so two projects named alike stay apart', async () => {
  const { IconResolverKey } = await import('@moonshot-ai/app-ui');
  const { KimiI18nKey } = await import('@moonshot-ai/app-i18n');
  const { setKimiClientDeps } = await import('@moonshot-ai/app-client/client');
  const { clientPinia, workspacesStore } = await import('@moonshot-ai/app-client/stores');
  const { default: i18n } = await import('../../src/renderer/i18n');
  const { default: SettingsDialog } = await import('../../src/renderer/components/settings/SettingsDialog.vue');
  const archived = (title: string, workspaceId: string, cwd: string) => ({
    id: title, title, workspaceId, cwd, archived: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const items = [archived('in a', 'wd_a', '/a/app'), archived('in b', 'wd_b', '/b/app')];
  setKimiClientDeps({ api: () => ({ listSessions: async () => ({ items }) }), t: (key: string) => key } as never);
  workspacesStore().workspaces = [
    { id: 'wd_a', root: '/a/app', name: 'app', kind: 'implicit', additionalDirs: [], sessionCount: 0 },
    { id: 'wd_b', root: '/b/app', name: 'app', kind: 'implicit', additionalDirs: [], sessionCount: 0 },
  ];

  const host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    render: () =>
      h(SettingsDialog, {
        colorScheme: 'light',
        fontScale: 'medium',
        notify: false,
        notifySound: false,
        initialTab: 'archived',
        onFetchUsage: async () => ({ kind: 'error' }) as never,
      }),
  });
  app.use(i18n);
  app.use(clientPinia);
  app.provide(KimiI18nKey, { t: (key: string) => key });
  app.provide(IconResolverKey, () => defineComponent({ render: () => h('svg') }));
  app.mount(host);
  const text = (element: Element | null) => element?.textContent?.trim();
  const groups = () => [...document.querySelectorAll('.archive-card')].map((card) => [
    [...card.querySelectorAll('.archive-workspace .path')].map(text),
    [...card.querySelectorAll('.archive-name')].map(text),
  ]);
  const trigger = () => document.querySelector<HTMLButtonElement>('.archive-toolbar [role="combobox"]')!;
  const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

  await vi.waitFor(() => expect(groups()).toEqual([
    [['app', '/a/app'], ['in a']],
    [['app', '/b/app'], ['in b']],
  ]));

  trigger().click();
  await flush();
  expect(options().map(text).slice(1)).toEqual(['app/a/app', 'app/b/app']);
  options()[2]!.click();
  await flush();

  expect(text(trigger())).toBe('app');
  expect(groups()).toEqual([[['app', '/b/app'], ['in b']]]);
  workspacesStore().workspaces = [];
}, 60_000);
