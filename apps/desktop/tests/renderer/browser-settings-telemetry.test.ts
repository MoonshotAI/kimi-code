// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import browser from '../../../../packages/app-i18n/src/locales/en/browser';
import type { BrowserDataSnapshot, BrowserPreferences, BrowserPreferencesPatch } from '../../src/shared/browser-data';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  choose: vi.fn(),
  track: vi.fn(),
}));

vi.mock('../../src/renderer/lib/nativeBrowser', () => ({
  getNativeBrowserBridge: () => ({
    browserGetData: async () => current,
    browserUpdatePreferences: mocks.update,
    browserChooseAgentDownloadDirectory: mocks.choose,
    browserGetDownloads: async () => [],
    browserWatchDownloads: vi.fn(),
    onBrowserDownloads: () => () => {},
  }),
}));

vi.mock('../../src/renderer/lib/track', () => ({ track: mocks.track }));

import BrowserSettingsTab from '../../src/renderer/components/browser/BrowserSettingsTab.vue';

let current: BrowserDataSnapshot;
let app: App | undefined;
let host: HTMLDivElement;

function snapshot(): BrowserDataSnapshot {
  return {
    history: [],
    preferences: { agentControl: true, subagentControl: false, agentLocalFiles: false, autoplay: 'block', sound: 'muted', askWhereToSave: false, defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] },
    defaultUserAgent: 'Mozilla/5.0',
    agentDownloads: { path: '/Users/me/Downloads', custom: false, fallback: false, access: 'granted' },
  };
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div');
  document.body.append(host);
  current = snapshot();
  mocks.update.mockImplementation(async (request: BrowserPreferencesPatch) => {
    const { agentDownloadDirectory, ...patch } = request;
    const preferences: BrowserPreferences = { ...current.preferences, ...patch } as BrowserPreferences;
    current = { ...current, preferences };
    if (agentDownloadDirectory === null) current = { ...current, agentDownloads: { ...current.agentDownloads!, path: '/Users/me/Downloads', custom: false } };
    return current;
  });
  mocks.choose.mockImplementation(async () => {
    current = { ...current, agentDownloads: { ...current.agentDownloads!, path: '/Volumes/secret/agent', custom: true } };
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

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await nextTick();
}

async function mount(): Promise<void> {
  app = createApp(BrowserSettingsTab, { initialSection: 'settings' });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: { browser, settings: { tabs: { browser: 'Browser' } }, common: { cancel: 'Cancel', close: 'Close' } } } }));
  app.mount(host);
  await vi.waitFor(() => expect(host.querySelector('[role="switch"]')).not.toBeNull());
}

function toggle(label: string): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;
}

async function choose(label: string, option: string): Promise<void> {
  host.querySelector<HTMLElement>(`[role="combobox"][aria-label="${label}"]`)!.click();
  await settle();
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent?.trim() === option)!.click();
  await settle();
}

function button(text: string): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim() === text)!;
}

function lastPayload(): unknown {
  return mocks.track.mock.lastCall;
}

it('tracks each browser switch with an on/off value', async () => {
  await mount();
  toggle(browser.settings.agentControl).click();
  await settle();
  expect(lastPayload()).toEqual(['settings_changed', { key: 'browser-agent-control', value: 'off', source_panel: 'settings' }]);
  toggle(browser.settings.agentControl).click();
  await settle();
  toggle(browser.settings.subagentControl).click();
  await settle();
  expect(lastPayload()).toEqual(['settings_changed', { key: 'browser-subagent-control', value: 'on', source_panel: 'settings' }]);
  toggle(browser.settings.downloadsPrompt).click();
  await settle();
  expect(lastPayload()).toEqual(['settings_changed', { key: 'browser-ask-where-to-save', value: 'on', source_panel: 'settings' }]);
});

it('tracks the search engine id, zoom preset and download limit as enum values', async () => {
  await mount();
  await choose(browser.settings.searchEngine, 'DuckDuckGo');
  expect(lastPayload()).toEqual(['settings_changed', { key: 'browser-search-engine', value: 'duckduckgo', source_panel: 'settings' }]);
  await choose(browser.settings.defaultZoom, '90%');
  expect(mocks.update).toHaveBeenLastCalledWith({ defaultZoomFactor: 0.9 });
  expect(lastPayload()).toEqual(['settings_changed', { key: 'browser-default-zoom', value: '90', source_panel: 'settings' }]);
  await choose(browser.settings.agentDownloadLimit, browser.settings.agentDownloadUnlimited);
  expect(lastPayload()).toEqual(['settings_changed', { key: 'browser-agent-download-limit', value: 'unlimited', source_panel: 'settings' }]);
  await choose(browser.settings.agentDownloadLimit, '500 MB');
  expect(lastPayload()).toEqual(['settings_changed', { key: 'browser-agent-download-limit', value: '500mb', source_panel: 'settings' }]);
});

it('tracks the agent download location as default or custom without the path', async () => {
  await mount();
  button(browser.settings.agentDownloadChoose).click();
  await settle();
  expect(lastPayload()).toEqual(['settings_changed', { key: 'browser-agent-download-location', value: 'custom', source_panel: 'settings' }]);
  button(browser.settings.agentDownloadReset).click();
  await settle();
  expect(lastPayload()).toEqual(['settings_changed', { key: 'browser-agent-download-location', value: 'default', source_panel: 'settings' }]);
  expect(JSON.stringify(mocks.track.mock.calls)).not.toContain('/Volumes');
});

it('does not track a cancelled download location picker', async () => {
  await mount();
  mocks.choose.mockImplementationOnce(async () => current);
  button(browser.settings.agentDownloadChoose).click();
  await settle();
  expect(mocks.track).not.toHaveBeenCalled();
});
