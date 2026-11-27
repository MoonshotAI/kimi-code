// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { noopProductTracker, setProductTracker } from '@moonshot-ai/app-client/contracts';
import { useFontPrefs, type FontTarget } from '@moonshot-ai/app-core/composables';

vi.mock('../src/settings/FontSettingsPreview.vue', () => ({
  default: defineComponent({ render: () => h('figure') }),
}));

import FontSettingsPage from '../src/settings/FontSettingsPage.vue';

const track = vi.fn();
let app: App | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  setProductTracker({ track });
  const { setFontPref } = useFontPrefs();
  setFontPref('code', { mode: 'system', families: [] });
  setFontPref('transcript', { mode: 'same', families: [] });
  setFontPref('terminal', { mode: 'same', families: [], size: null });
});

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
  setProductTracker(noopProductTracker);
  track.mockReset();
});

async function flush(): Promise<void> {
  await nextTick();
  await nextTick();
}

async function mount(target: FontTarget, sourcePanel?: 'settings' | 'mobile_settings'): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(defineComponent({ setup: () => () => h(FontSettingsPage, { target, sourcePanel }) }));
  app.provide(IconResolverKey, (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  await flush();
  return host;
}

function radio(root: HTMLElement, index: number): HTMLElement {
  return root.querySelectorAll<HTMLElement>('[role="radio"]')[index]!;
}

it('tracks a font mode change with the surface key and mode only', async () => {
  const root = await mount('code');
  radio(root, 2).click();
  await flush();
  expect(useFontPrefs().fontPrefs.value.code.mode).toBe('custom');
  expect(track).toHaveBeenCalledExactlyOnceWith('settings_changed', { key: 'font-code', value: 'custom', source_panel: 'settings' });
  const payload = JSON.stringify(track.mock.calls);
  for (const family of useFontPrefs().fontPrefs.value.code.families) expect(payload).not.toContain(family);
});

it('reports the mobile settings panel when opened from the mobile sheet', async () => {
  const root = await mount('transcript', 'mobile_settings');
  radio(root, 1).click();
  await flush();
  expect(track).toHaveBeenCalledExactlyOnceWith('settings_changed', { key: 'font-transcript', value: 'kimi', source_panel: 'mobile_settings' });
});

it('does not track re-selecting the current mode', async () => {
  const root = await mount('code');
  radio(root, 1).click();
  await flush();
  expect(track).not.toHaveBeenCalled();
});

it('tracks the terminal size as its clamped integer and default when cleared', async () => {
  const root = await mount('terminal');
  const input = root.querySelector<HTMLInputElement>('.fs-control--narrow input')!;
  input.value = '40';
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('blur'));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  await flush();
  expect(track).toHaveBeenLastCalledWith('settings_changed', { key: 'font-terminal-size', value: '32', source_panel: 'settings' });
  input.value = '';
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  input.dispatchEvent(new Event('blur'));
  await flush();
  expect(track).toHaveBeenLastCalledWith('settings_changed', { key: 'font-terminal-size', value: 'default', source_panel: 'settings' });
});
