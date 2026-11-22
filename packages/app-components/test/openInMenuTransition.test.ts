// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { OpenInServiceKey, type OpenInService } from '@moonshot-ai/app-client/contracts';
import OpenInMenu from '../src/chat/OpenInMenu.vue';

let app: App | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
});

it('animates the open-in menu when it opens and closes', async () => {
  const service: OpenInService = {
    catalog: async () => [{ id: 'vscode', label: 'VS Code' }],
    open: async () => true,
    icon: () => '',
  };
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(OpenInMenu, { workDir: '/work' }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(OpenInServiceKey, service);
  app.mount(host);
  await vi.waitFor(() => expect(host!.querySelector('.open-in-caret')).not.toBeNull());

  host.querySelector<HTMLButtonElement>('.open-in-caret')!.click();
  await nextTick();
  await nextTick();
  const menu = host.querySelector<HTMLElement>('.open-in-menu')!;
  expect(menu.classList.contains('menu-pop-enter-active')).toBe(true);

  window.dispatchEvent(new Event('resize'));
  await nextTick();
  expect(menu.classList.contains('menu-pop-leave-active')).toBe(true);
});
