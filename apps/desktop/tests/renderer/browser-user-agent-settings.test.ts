// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import browser from '../../../../packages/app-i18n/src/locales/en/browser';
import type { BrowserDataSnapshot, BrowserPreferences, BrowserPreferencesPatch } from '../../src/shared/browser-data';
import type { BrowserUserAgentSavedPreset } from '../../src/shared/browser-user-agent';

const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7000.10 Safari/537.36';
const CUSTOM_UA = 'Custom/1.0';
const FIREFOX_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  track: vi.fn(),
  copy: vi.fn(async (_text: string) => true),
}));

vi.mock('../../src/renderer/lib/nativeBrowser', () => ({
  getNativeBrowserBridge: () => ({ browserUpdatePreferences: mocks.update }),
}));

vi.mock('../../src/renderer/lib/track', () => ({ track: mocks.track }));

vi.mock('@moonshot-ai/app-core/lib', async (importOriginal) => ({
  ...await importOriginal<typeof import('@moonshot-ai/app-core/lib')>(),
  copyTextToClipboard: mocks.copy,
}));

import BrowserUserAgentSettings from '../../src/renderer/components/browser/BrowserUserAgentSettings.vue';

function snapshot(customUserAgent: string | null, userAgentPresets: BrowserUserAgentSavedPreset[] = []): BrowserDataSnapshot {
  return {
    history: [],
    preferences: { agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent, userAgentPresets },
    defaultUserAgent: DEFAULT_UA,
  };
}

let app: App | undefined;
let host: HTMLDivElement;
let current: BrowserDataSnapshot;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div');
  document.body.append(host);
  mocks.update.mockImplementation(async (request: BrowserPreferencesPatch) => {
    const { agentDownloadDirectory, ...patch } = structuredClone(request);
    const preferences: BrowserPreferences = { ...current.preferences, ...patch };
    if (agentDownloadDirectory === null) delete preferences.agentDownloadDirectory;
    current = { ...current, preferences };
    return current;
  });
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function mount(initial: BrowserDataSnapshot): Promise<void> {
  current = initial;
  const Root = {
    components: { BrowserUserAgentSettings },
    data: () => ({ snapshot: current }),
    template: '<BrowserUserAgentSettings :snapshot="snapshot" @update="snapshot = $event" />',
  };
  app = createApp(Root);
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: { browser, common: { cancel: 'Cancel', close: 'Close' } } } }));
  app.mount(host);
  await nextTick();
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await nextTick();
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(entry => entry.textContent?.trim() === text);
  if (found === undefined) throw new Error(`missing button ${text}`);
  return found;
}

function loadButton(): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('.bua-load-preset')!;
}

function presetMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.bua-preset-menu');
}

function menuItems(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.bua-preset-menu .ui-menu-item')];
}

function menuLabels(): string[] {
  return menuItems().map(item => item.textContent?.trim() ?? '');
}

async function openPresetMenu(): Promise<string[]> {
  loadButton().click();
  await settle();
  return menuLabels();
}

async function pickPreset(label: string): Promise<void> {
  await openPresetMenu();
  menuItems().find(item => item.textContent?.trim() === label)!.click();
  await settle();
}

function key(target: Element, name: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));
}

function draft(): HTMLTextAreaElement {
  return host.querySelector<HTMLTextAreaElement>('textarea')!;
}

async function typeName(name: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('.ui-dialog input')!;
  input.value = name;
  input.dispatchEvent(new Event('input'));
  await settle();
}

function dialogError(): string {
  return document.querySelector('.ui-dialog .ui-field__error')?.textContent?.trim() ?? '';
}

it('renders the default user agent as read-only text with a copy action', async () => {
  await mount(snapshot(null));
  const value = host.querySelector('.bua-readonly')!;
  expect(value.tagName).toBe('P');
  expect(value.getAttribute('aria-readonly')).toBe('true');
  expect(value.textContent).toBe(DEFAULT_UA);
  expect(host.querySelector('textarea, input')).toBeNull();
  expect(host.textContent?.trim()).not.toContain('Read-only');
  const copy = host.querySelector<HTMLButtonElement>('.bua-readonly-block .bua-copy')!;
  expect(copy.getAttribute('aria-label')).toBe('Copy');
  copy.click();
  await settle();
  expect(mocks.copy).toHaveBeenCalledWith(DEFAULT_UA);
  expect(copy.getAttribute('aria-label')).toBe('Copied');
});

it('shows an editable field in custom mode', async () => {
  await mount(snapshot(CUSTOM_UA));
  expect(host.querySelector('.bua-readonly')).toBeNull();
  expect(draft().readOnly).toBe(false);
  expect(draft().value).toBe(CUSTOM_UA);
});

it('stays in custom mode with an error when resetting to default fails', async () => {
  await mount(snapshot(CUSTOM_UA));
  mocks.update.mockRejectedValueOnce(new Error('disk full'));
  button('Default').click();
  await settle();
  expect(mocks.update).toHaveBeenCalledWith({ customUserAgent: null });
  expect(host.querySelector('.bua-readonly')).toBeNull();
  expect(draft().value).toBe(CUSTOM_UA);
  expect(host.querySelector('.bua-error')?.textContent?.trim()).toBe(browser.settings.userAgentSaveFailed);
  expect(mocks.track).not.toHaveBeenCalled();
});

it('stays in custom mode with an error when the reset is not persisted', async () => {
  await mount(snapshot(CUSTOM_UA));
  mocks.update.mockImplementationOnce(async () => current);
  button('Default').click();
  await settle();
  expect(mocks.update).toHaveBeenCalledWith({ customUserAgent: null });
  expect(host.querySelector('.bua-readonly')).toBeNull();
  expect(draft().value).toBe(CUSTOM_UA);
  expect(host.querySelector('.bua-error')?.textContent?.trim()).toBe(browser.settings.userAgentSaveFailed);
  expect(mocks.track).not.toHaveBeenCalled();
});

it('tracks applying a custom user agent and resetting to default without the string', async () => {
  await mount(snapshot(null));
  button('Custom').click();
  await settle();
  draft().value = 'Other/3.0';
  draft().dispatchEvent(new Event('input'));
  await settle();
  button('Apply').click();
  await settle();
  expect(mocks.track).toHaveBeenLastCalledWith('settings_changed', { key: 'browser-user-agent', value: 'custom', source_panel: 'settings' });
  button('Default').click();
  await settle();
  expect(mocks.track).toHaveBeenLastCalledWith('settings_changed', { key: 'browser-user-agent', value: 'default', source_panel: 'settings' });
  expect(JSON.stringify(mocks.track.mock.calls)).not.toContain('Other/3.0');
});

it('shows load and save preset buttons side by side instead of a select', async () => {
  await mount(snapshot(CUSTOM_UA));
  const pair = host.querySelector('.bua-preset-actions')!;
  expect([...pair.children].map(child => child.textContent?.trim())).toEqual(['Load preset…', 'Save as preset…']);
  expect(host.querySelector('.ui-select, [role="combobox"]')).toBeNull();
  const load = loadButton();
  const save = button('Save as preset…');
  expect(load.className).toBe(save.className.replace('bua-save-preset', 'bua-load-preset'));
  expect(load.getAttribute('aria-haspopup')).toBe('menu');
  expect(load.getAttribute('aria-expanded')).toBe('false');
  expect(presetMenu()).toBeNull();
});

it('labels built-in presets with the version and platform they produce', async () => {
  await mount(snapshot(CUSTOM_UA, [{ name: 'Staging', value: 'Staging/2.0' }]));
  expect(await openPresetMenu()).toEqual(['Chrome 150 · macOS', 'Edge 150 · macOS', 'Safari 18.5 · macOS', 'Firefox 140 · macOS', 'Staging']);
  expect(presetMenu()!.parentElement).toBe(document.body);
  expect(presetMenu()!.querySelector('[role="menu"]')).not.toBeNull();
  expect(loadButton().getAttribute('aria-expanded')).toBe('true');
  expect([...document.querySelectorAll('.bua-preset-group')].map(group => group.textContent?.trim())).toEqual(['Built-in', 'Saved']);
  menuItems()[0]!.click();
  await settle();
  expect(draft().value).toContain('Chrome/150.0.0.0');
  expect(presetMenu()).toBeNull();
  expect(document.activeElement).toBe(loadButton());
  expect(loadButton().textContent?.trim()).toBe('Load preset…');
  await pickPreset('Edge 150 · macOS');
  expect(draft().value).toMatch(/Edg\/150\.0\.0\.0$/);
  await pickPreset('Safari 18.5 · macOS');
  expect(draft().value).toContain('Version/18.5');
  await pickPreset('Firefox 140 · macOS');
  expect(draft().value).toContain('Firefox/140.0');
  await pickPreset('Staging');
  expect(draft().value).toBe('Staging/2.0');
  expect(mocks.update).not.toHaveBeenCalled();
});

it('saves the custom user agent as a named preset without applying it', async () => {
  await mount(snapshot(CUSTOM_UA, [{ name: 'Staging', value: 'Staging/2.0' }]));
  draft().value = 'Other/3.0';
  draft().dispatchEvent(new Event('input'));
  await settle();
  button('Save as preset…').click();
  await settle();
  const submit = document.querySelector<HTMLButtonElement>('.bua-preset-submit')!;
  expect(submit.disabled).toBe(true);
  await typeName('   ');
  expect(submit.disabled).toBe(true);
  await typeName('x'.repeat(61));
  expect(dialogError()).toBe('The preset name must be 60 characters or fewer');
  await typeName(' staging ');
  expect(dialogError()).toBe('A preset with this name already exists');
  expect(submit.disabled).toBe(true);
  await typeName('  Mobile  ');
  expect(dialogError()).toBe('');
  submit.click();
  await settle();
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(mocks.update).toHaveBeenCalledWith({
    userAgentPresets: [{ name: 'Staging', value: 'Staging/2.0' }, { name: 'Mobile', value: 'Other/3.0' }],
  });
  expect(current.preferences.customUserAgent).toBe(CUSTOM_UA);
  expect(mocks.track).toHaveBeenCalledExactlyOnceWith('settings_changed', { key: 'browser-user-agent-presets', value: 'added', source_panel: 'settings' });
  expect(document.querySelector('.ui-dialog')).toBeNull();
  expect(host.querySelector('.bua-saved-name, .bua-saved')).toBeNull();
  expect((await openPresetMenu()).slice(-2)).toEqual(['Staging', 'Mobile']);
});

it('saves a second preset that shares the user agent of an existing one', async () => {
  await mount(snapshot(FIREFOX_UA, [{ name: 'Test', value: FIREFOX_UA }]));
  button('Save as preset…').click();
  await settle();
  await typeName('Test 2');
  expect(dialogError()).toBe('');
  document.querySelector<HTMLButtonElement>('.bua-preset-submit')!.click();
  await settle();
  expect(mocks.update).toHaveBeenCalledWith({
    userAgentPresets: [{ name: 'Test', value: FIREFOX_UA }, { name: 'Test 2', value: FIREFOX_UA }],
  });
  expect(document.querySelector('.ui-dialog')).toBeNull();
  expect(current.preferences.userAgentPresets.map(preset => preset.name)).toEqual(['Test', 'Test 2']);
});

it('shows the generic save error only when the bridge fails for an unknown reason', async () => {
  await mount(snapshot(CUSTOM_UA, [{ name: 'Staging', value: 'Staging/2.0' }]));
  mocks.update.mockRejectedValueOnce(new Error('ipc down'));
  button('Save as preset…').click();
  await settle();
  await typeName('Staging');
  expect(dialogError()).toBe('A preset with this name already exists');
  await typeName('Mobile');
  document.querySelector<HTMLButtonElement>('.bua-preset-submit')!.click();
  await settle();
  expect(dialogError()).toBe('Could not save the preset');
});

it('keeps the preset dialog open with an error when the preset is not persisted', async () => {
  await mount(snapshot(CUSTOM_UA));
  mocks.update.mockImplementationOnce(async () => current);
  button('Save as preset…').click();
  await settle();
  await typeName('Mobile');
  document.querySelector<HTMLButtonElement>('.bua-preset-submit')!.click();
  await settle();
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.bua-preset-submit')).not.toBeNull();
  expect(dialogError()).toBe('Could not save the preset');
});

it('shows an empty-name error on submit and a full-list error at the cap', async () => {
  await mount(snapshot(CUSTOM_UA));
  button('Save as preset…').click();
  await settle();
  document.querySelector('.ui-dialog form')!.dispatchEvent(new Event('submit'));
  await settle();
  expect(dialogError()).toBe('Enter a preset name');
  expect(mocks.update).not.toHaveBeenCalled();
  app!.unmount();
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.append(host);
  await mount(snapshot(CUSTOM_UA, Array.from({ length: 20 }, (_, index) => ({ name: `Preset ${index}`, value: `Agent/${index}` }))));
  button('Save as preset…').click();
  await settle();
  expect(dialogError()).toBe('You can save up to 20 presets. Delete one to save another');
  expect(document.querySelector<HTMLButtonElement>('.bua-preset-submit')!.disabled).toBe(true);
});

function menuRow(label: string): HTMLElement {
  const item = menuItems().find(entry => entry.textContent?.trim() === label);
  if (item === undefined) throw new Error(`missing row ${label}`);
  return item.closest<HTMLElement>('.ui-menu-item-row') ?? item;
}

it('deletes a saved preset from the menu after an inline confirmation', async () => {
  await mount(snapshot(CUSTOM_UA, [{ name: 'Staging', value: 'Staging/2.0' }, { name: 'Mobile', value: 'Mobile/1.0' }]));
  await openPresetMenu();
  const deletes = [...document.querySelectorAll<HTMLButtonElement>('.bua-preset-menu .bua-delete-preset')];
  expect(deletes.map(entry => entry.getAttribute('aria-label'))).toEqual(['Delete preset Staging', 'Delete preset Mobile']);
  expect(menuRow('Chrome 150 · macOS').querySelector('.bua-delete-preset')).toBeNull();
  expect(menuRow('Staging').contains(deletes[0]!)).toBe(true);
  expect(document.querySelectorAll('.bua-preset-menu button button')).toHaveLength(0);
  deletes[0]!.click();
  await settle();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(presetMenu()).not.toBeNull();
  expect(draft().value).toBe(CUSTOM_UA);
  const confirmDelete = menuRow('Staging').querySelector<HTMLButtonElement>('.bua-confirm-delete')!;
  expect(confirmDelete.getAttribute('aria-label')).toBe('Confirm deleting preset Staging');
  expect(document.activeElement).toBe(confirmDelete);
  confirmDelete.click();
  await settle();
  expect(mocks.update).toHaveBeenCalledWith({ userAgentPresets: [{ name: 'Mobile', value: 'Mobile/1.0' }] });
  expect(mocks.track).toHaveBeenCalledExactlyOnceWith('settings_changed', { key: 'browser-user-agent-presets', value: 'removed', source_panel: 'settings' });
  expect(draft().value).toBe(CUSTOM_UA);
  expect(presetMenu()).not.toBeNull();
  expect(menuLabels()).not.toContain('Staging');
  expect(document.activeElement).toBe(menuItems().find(item => item.textContent?.trim() === 'Mobile'));
});

it('closes the menu on an outside click without applying a preset', async () => {
  await mount(snapshot(CUSTOM_UA));
  await openPresetMenu();
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await settle();
  expect(presetMenu()).toBeNull();
  expect(draft().value).toBe(CUSTOM_UA);
});

it('opens with the keyboard, moves between items and closes on Escape', async () => {
  await mount(snapshot(CUSTOM_UA, [{ name: 'Staging', value: 'Staging/2.0' }]));
  const trigger = loadButton();
  trigger.focus();
  key(trigger, 'ArrowDown');
  await settle();
  expect(presetMenu()).not.toBeNull();
  expect(document.activeElement).toBe(menuItems()[0]);
  key(document.activeElement!, 'ArrowDown');
  expect(document.activeElement).toBe(menuItems()[1]);
  key(document.activeElement!, 'ArrowUp');
  key(document.activeElement!, 'ArrowUp');
  expect(document.activeElement).toBe(menuItems().at(-1));
  key(document.activeElement!, 'Home');
  expect(document.activeElement).toBe(menuItems()[0]);
  const dialogEscape = vi.fn();
  window.addEventListener('keydown', dialogEscape);
  key(document.activeElement!, 'Escape');
  window.removeEventListener('keydown', dialogEscape);
  await settle();
  expect(dialogEscape).not.toHaveBeenCalled();
  expect(presetMenu()).toBeNull();
  expect(document.activeElement).toBe(trigger);
  key(trigger, 'ArrowUp');
  await settle();
  expect(document.activeElement).toBe(menuItems().at(-1));
  (document.activeElement as HTMLButtonElement).click();
  await settle();
  expect(draft().value).toBe('Staging/2.0');
  expect(presetMenu()).toBeNull();
});

it('reaches the delete action from the keyboard', async () => {
  await mount(snapshot(CUSTOM_UA, [{ name: 'Staging', value: 'Staging/2.0' }]));
  const trigger = loadButton();
  trigger.focus();
  key(trigger, 'ArrowDown');
  await settle();
  key(document.activeElement!, 'End');
  const item = document.activeElement!;
  expect(item.textContent?.trim()).toBe('Staging');
  key(item, 'Tab');
  const trash = menuRow('Staging').querySelector<HTMLButtonElement>('.bua-delete-preset')!;
  expect(document.activeElement).toBe(trash);
  key(trash, 'Tab', { shiftKey: true });
  expect(document.activeElement).toBe(item);
  trash.click();
  await settle();
  const confirmDelete = document.activeElement as HTMLButtonElement;
  expect(confirmDelete.classList.contains('bua-confirm-delete')).toBe(true);
  key(confirmDelete, 'ArrowUp');
  expect(document.activeElement?.textContent?.trim()).toBe('Firefox 140 · macOS');
  key(document.activeElement!, 'Escape');
  await settle();
  expect(presetMenu()).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(mocks.update).not.toHaveBeenCalled();
  await openPresetMenu();
  expect(menuRow('Staging').querySelector('.bua-delete-preset')).not.toBeNull();
  key(document.activeElement!, 'Tab');
  await settle();
  expect(presetMenu()).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

