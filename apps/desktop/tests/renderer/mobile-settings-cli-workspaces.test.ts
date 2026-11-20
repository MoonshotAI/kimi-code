// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { resetKimiClientDeps, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { clientPinia, workspacesStore } from '@moonshot-ai/app-client/stores';

vi.mock('@moonshot-ai/app-client/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/client')>();
  return {
    ...actual,
    useKimiWebClient: () => ({
      config: { value: {} },
      getUsage: vi.fn(),
    }),
  };
});

vi.mock('@moonshot-ai/app-components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-components')>();
  const stub = { render: () => null };
  return {
    ...actual,
    BottomSheet: {
      render(this: { $slots: { default?: () => ReturnType<typeof h>[] } }) {
        return h('div', this.$slots.default?.());
      },
    },
    BrowserTabTitleSetting: stub,
    FontSettingsPage: stub,
    FontSettingsRow: stub,
    ProvidersPanel: stub,
  };
});

import MobileSettingsSheet from '../../src/renderer/components/mobile/MobileSettingsSheet.vue';

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

it('toggles the shared CLI project visibility setting from mobile settings', async () => {
  app = createApp({
    render: () => h(MobileSettingsSheet, {
      modelValue: true,
      status: { ctxMax: 0, ctxUsed: 0 } as never,
    }),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.use(clientPinia);
  app.mount(host);
  await nextTick();

  const control = [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
    .find((button) => button.textContent?.includes('Show CLI projects'))!;
  expect(control).not.toBeNull();
  expect(control.getAttribute('aria-checked')).toBe('false');

  control.click();
  await nextTick();

  expect(control.getAttribute('aria-checked')).toBe('true');
  expect(workspacesStore().showCliWorkspaces).toBe(true);
  expect(localStorage.getItem('kimi-web.show-cli-workspaces')).toBe('1');
});
