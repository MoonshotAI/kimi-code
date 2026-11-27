// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { useFontPrefs, type LocalFontsState } from '@moonshot-ai/app-core/composables';

const local = vi.hoisted(() => ({ state: null as unknown as { value: string }, families: null as unknown as { value: string[] } }));
vi.mock('@moonshot-ai/app-core/composables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-core/composables')>();
  const { ref: vueRef } = await import('vue');
  local.state = vueRef<string>('unavailable');
  local.families = vueRef<string[]>([]);
  return {
    ...actual,
    ensureLocalFontsIfPermitted: () => {},
    useLocalFonts: () => ({ localFontsState: local.state, localFontFamilies: local.families, ensureLocalFonts: () => {} }),
  };
});
vi.mock('../src/settings/FontSettingsPreview.vue', () => ({
  default: defineComponent({ render: () => h('figure') }),
}));

import FontSettingsPage from '../src/settings/FontSettingsPage.vue';

let app: App | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  local.state.value = 'unavailable';
  local.families.value = [];
  useFontPrefs().setFontPref('code', { mode: 'custom', families: [] });
});

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await nextTick();
  await nextTick();
}

async function openMenu(state: LocalFontsState, draft = '') {
  local.state.value = state;
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(defineComponent({ setup: () => () => h(FontSettingsPage, { target: 'code' }) }));
  app.provide(IconResolverKey, (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  await flush();
  const input = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  input.dispatchEvent(new FocusEvent('focus'));
  input.value = draft;
  input.dispatchEvent(new Event('input'));
  await flush();
  return input;
}

const addRow = () => document.querySelector<HTMLElement>('.fs-menu-add');
const note = () => document.querySelector<HTMLElement>('.fs-menu-note');
const families = () => useFontPrefs().fontPrefs.value.code.families;

describe('font family menu', () => {
  it('offers an Add row for an unknown name and adds it on click', async () => {
    await openMenu('unavailable', 'Berkeley Mono');
    expect(addRow()?.getAttribute('role')).toBe('option');
    expect(addRow()?.textContent).toContain('Add "Berkeley Mono"');
    addRow()!.click();
    await flush();
    expect(families()).toEqual(['Berkeley Mono']);
  });

  it('selects the Add row with the arrow keys and adds it on Enter', async () => {
    const input = await openMenu('unavailable', 'Berkeley Mono');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }));
    await flush();
    expect(input.getAttribute('aria-activedescendant')).toBe(addRow()!.id);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    expect(families()).toEqual(['Berkeley Mono']);
  });

  it('offers no Add row for an exact match or a generic family', async () => {
    local.families.value = ['Menlo'];
    const input = await openMenu('ready', 'menlo');
    expect(document.querySelector('[role="option"]')).not.toBeNull();
    expect(addRow()).toBeNull();
    input.value = 'monospace';
    input.dispatchEvent(new Event('input'));
    await flush();
    expect(addRow()).toBeNull();
  });

  it('prefills Custom without the system font entry', async () => {
    useFontPrefs().setFontPref('code', { mode: 'system', families: [] });
    host = document.createElement('div');
    document.body.append(host);
    app = createApp(defineComponent({ setup: () => () => h(FontSettingsPage, { target: 'code' }) }));
    app.provide(IconResolverKey, (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await flush();
    const card = [...document.querySelectorAll<HTMLElement>('.ui-radio-card')].find(
      (element) => element.querySelector('.ui-radio-card__label')?.textContent?.trim() === 'Custom',
    );
    card!.click();
    await flush();
    expect(useFontPrefs().fontPrefs.value.code).toMatchObject({ mode: 'custom', families: [] });
    expect(document.querySelectorAll('.fs-chip-origin')).toHaveLength(0);
  });

  it('badges each saved family by where it comes from', async () => {
    local.families.value = ['Menlo'];
    useFontPrefs().setFontPref('code', { families: ['ui-monospace', 'test', 'Menlo', 'JetBrains Mono Variable'] });
    await openMenu('ready');
    const badges = [...document.querySelectorAll<HTMLElement>('.fs-chip-origin')].map((badge) => [
      badge.textContent?.trim(),
      [...badge.classList].find((name) => name.startsWith('ui-badge--') && name !== 'ui-badge--sm'),
    ]);
    expect(badges).toEqual([
      ['System default', 'ui-badge--neutral'],
      ['Manual', 'ui-badge--warning'],
      ['Installed', 'ui-badge--success'],
      ['Bundled', 'ui-badge--info'],
    ]);
  });

  it('explains the missing font list only when it is unavailable', async () => {
    await openMenu('unavailable');
    expect(note()?.textContent).toContain("This browser can't list your installed fonts.");
    app?.unmount();
    document.querySelectorAll('.fs-menu').forEach((menu) => menu.remove());
    for (const state of ['ready', 'querying'] as const) {
      await openMenu(state);
      expect(note()).toBeNull();
      app?.unmount();
    }
    app = null;
  });

  it('restores the open menu layout when the query is cleared', async () => {
    local.families.value = ['Menlo', 'Monaco', 'Consolas'];
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('fs-tokens')) {
        return { top: 600, bottom: 632, left: 20, right: 320, width: 300, height: 32, x: 20, y: 600 } as DOMRect;
      }
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('fs-menu') ? this.querySelectorAll('[role="option"]').length * 40 : 0;
    });
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(700);
    const input = await openMenu('ready', 'Menlo');
    const menu = document.querySelector<HTMLElement>('.fs-menu')!;
    expect(menu.style.top).toBe('636px');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    await flush();
    expect(document.querySelector('.fs-menu')).toBe(menu);
    expect(menu.style.top).toBe('396px');
    expect(menu.style.maxHeight).toBe('240px');
  });
});
