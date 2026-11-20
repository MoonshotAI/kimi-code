// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { resetKimiClientDeps, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { clientPinia, workspacesStore } from '@moonshot-ai/app-client/stores';
import SettingsDialog from '../../src/renderer/components/settings/SettingsDialog.vue';

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  workspacesStore().showCliWorkspaces = false;
  setKimiClientDeps({ api: () => ({}), t: (key: string) => key } as never);
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  resetKimiClientDeps();
});

it('enables and persists CLI project visibility from the Agent & Sessions settings', async () => {
  app = createApp({
    render: () => h(SettingsDialog, {
      colorScheme: 'light',
      fontScale: 'medium',
      notify: false,
      notifySound: false,
      initialTab: 'agent',
      onFetchUsage: async () => ({ kind: 'error' }) as never,
    }),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.use(clientPinia);
  app.provide(IconResolverKey, () => defineComponent({ render: () => h('svg') }));
  app.mount(host);
  await nextTick();

  const control = document.querySelector<HTMLElement>('[aria-label="Show CLI projects"]')!;
  expect(control).not.toBeNull();
  const sections = [...control.closest('.panel')!.querySelectorAll<HTMLElement>('.sec-title')];
  expect(sections.at(-1)?.textContent).toBe('CLI projects');
  control.click();
  await nextTick();

  expect(workspacesStore().showCliWorkspaces).toBe(true);
  expect(localStorage.getItem('kimi-web.show-cli-workspaces')).toBe('1');

  control.click();
  await nextTick();

  expect(workspacesStore().showCliWorkspaces).toBe(false);
  expect(localStorage.getItem('kimi-web.show-cli-workspaces')).toBe('0');
});
