// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import WorkspaceTrustDialog from '../src/chat/WorkspaceTrustDialog.vue';

let app: App | undefined;
let host: HTMLDivElement | undefined;

async function trustKeys(platform: string): Promise<(string | null | undefined)[]> {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp({ setup: () => () => h(WorkspaceTrustDialog, { open: true }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name) => defineComponent({ setup: () => () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
  await nextTick();
  return [...document.querySelectorAll('.opt-shortcut .ui-kbd__key')].map((key) =>
    key.querySelector('svg') === null ? key.textContent : key.querySelector('svg')?.getAttribute('data-icon'),
  );
}

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
  vi.restoreAllMocks();
});

describe('workspace trust shortcut hint', () => {
  it('shows Command and Enter on Apple platforms', async () => {
    expect(await trustKeys('MacIntel')).toEqual(['key-command', 'key-enter']);
  });

  it('shows Ctrl and Enter on other platforms', async () => {
    expect(await trustKeys('Win32')).toEqual(['Ctrl', 'key-enter']);
  });
});
