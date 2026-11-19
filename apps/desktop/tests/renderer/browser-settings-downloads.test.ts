// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import browser from '../../../../packages/app-i18n/src/locales/en/browser';
import browserZh from '../../../../packages/app-i18n/src/locales/zh/browser';
import type { BrowserDataSnapshot, BrowserDownloadItem } from '../../src/shared/browser-data';

const mocks = vi.hoisted(() => ({
  getData: vi.fn(),
  update: vi.fn(),
  getDownloads: vi.fn(),
  clear: vi.fn(),
  watch: vi.fn(),
  open: vi.fn(),
  remove: vi.fn(),
  copy: vi.fn(async (_text: string) => true),
  push: undefined as ((downloads: BrowserDownloadItem[]) => void) | undefined,
  off: vi.fn(),
}));

vi.mock('../../src/renderer/lib/nativeBrowser', () => ({
  getNativeBrowserBridge: () => ({
    browserGetData: mocks.getData,
    browserUpdatePreferences: mocks.update,
    browserOpenDownload: mocks.open,
    browserRemoveDownload: mocks.remove,
    browserClearDownloads: mocks.clear,
    browserGetDownloads: mocks.getDownloads,
    browserWatchDownloads: mocks.watch,
    onBrowserDownloads: (cb: (downloads: BrowserDownloadItem[]) => void) => { mocks.push = cb; return mocks.off; },
  }),
}));

vi.mock('@moonshot-ai/app-core/lib', async (importOriginal) => ({
  ...await importOriginal<typeof import('@moonshot-ai/app-core/lib')>(),
  copyTextToClipboard: mocks.copy,
}));

import BrowserSettingsTab from '../../src/renderer/components/browser/BrowserSettingsTab.vue';

const now = Date.now();
const base = { startedAt: now, receivedBytes: 10, totalBytes: 10 };
const completed = { ...base, id: 'done', url: 'https://example.com/done.zip', filename: 'done.zip', savePath: '/d/done.zip', state: 'completed' as const, fileMissing: false };
const deleted = { ...base, id: 'gone', url: 'https://example.com/gone.zip', filename: 'gone.zip', savePath: '/d/gone.zip', state: 'completed' as const, fileMissing: true };
const running = { ...base, id: 'run', url: 'https://example.com/run.zip', filename: 'run.zip', state: 'progressing' as const, receivedBytes: 25, totalBytes: 100 };
const cancelled = { ...base, id: 'stop', url: 'https://example.com/stop.zip', filename: 'stop.zip', state: 'cancelled' as const, receivedBytes: 0 };
const interrupted = { ...base, id: 'cut', url: 'https://example.com/cut.zip', filename: 'cut.zip', savePath: '/d/cut.zip', state: 'interrupted' as const };

function snapshot(): BrowserDataSnapshot {
  return { history: [], preferences: { agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: false, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] }, defaultUserAgent: 'Mozilla/5.0' };
}

let app: App | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  mocks.push = undefined;
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  vi.clearAllMocks();
});

async function mount(initialSection = 'downloads', data = snapshot()): Promise<void> {
  mocks.getData.mockResolvedValue(data);
  app = createApp(BrowserSettingsTab, { initialSection });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: { browser, settings: { tabs: { browser: 'Browser' } }, common: { loading: 'Loading' } } } }));
  app.mount(host);
  await vi.waitFor(() => expect(mocks.getData).toHaveBeenCalled());
  await nextTick();
  await nextTick();
}

function rows(): HTMLLIElement[] {
  return [...host.querySelectorAll<HTMLLIElement>('.bsp-item')];
}

function row(filename: string): HTMLLIElement {
  return rows().find((item) => item.textContent?.includes(filename))!;
}

function actions(item: HTMLElement): string[] {
  return [...item.querySelectorAll<HTMLButtonElement>('.bsp-item-actions button')].map((button) => button.getAttribute('aria-label')!);
}

function nameLink(item: HTMLElement): HTMLButtonElement | null {
  return item.querySelector<HTMLButtonElement>('button.bsp-download-name');
}

it('updates the global autoplay default from Browser settings', async () => {
  const data = snapshot();
  mocks.update.mockImplementation(async (patch: { autoplay: 'allow' | 'block' }) => ({ ...data, preferences: { ...data.preferences, ...patch } }));
  await mount('settings');
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Autoplay"]')!;
  expect(trigger.textContent).toContain('Block audible autoplay');
  trigger.click();
  await nextTick();
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(item => item.textContent?.includes('Allow audible autoplay'))!;
  option.click();
  await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ autoplay: 'allow' }));
  const sound = host.querySelector<HTMLButtonElement>('button[aria-label="Sound"]')!;
  expect(sound.textContent).toContain('Mute pages');
  sound.click();
  await nextTick();
  [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(item => item.textContent?.includes('Play sound'))!.click();
  await vi.waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith({ sound: 'on' }));
  expect(browserZh.settings.soundMuted).toBe('网页静音');
  expect(browserZh.settings.autoplayBlock).toBe('阻止有声自动播放');
  expect(browserZh.sites.autoplayStates.default).toBe('默认');
});

it('renders the name, status and actions for each download state without the source link', async () => {
  mocks.getDownloads.mockResolvedValue([completed, deleted, running, cancelled, interrupted]);
  await mount();
  expect(mocks.watch).toHaveBeenCalledExactlyOnceWith(true);

  const done = row('done.zip');
  expect(nameLink(done)!.textContent).toBe('done.zip');
  expect(done.textContent).not.toContain('https://example.com/done.zip');
  expect(done.querySelectorAll('small')).toHaveLength(1);
  expect(done.textContent).toContain('Completed');
  expect(done.querySelector('small')!.textContent).toMatch(/^Completed · 10 B · /);
  expect(actions(done)).toEqual(['Copy download link', 'Show in folder', 'Remove from list']);
  expect(done.querySelector('[role="progressbar"]')).toBeNull();

  const gone = row('gone.zip');
  expect(nameLink(gone)).toBeNull();
  expect(gone.querySelector('.bsp-download-deleted')!.textContent).toBe('gone.zip');
  expect(gone.textContent).toContain('Deleted');
  expect(actions(gone)).toEqual(['Copy download link', 'Remove from list']);

  const progressing = row('run.zip');
  expect(nameLink(progressing)).toBeNull();
  expect(progressing.querySelector('.bsp-download-deleted')).toBeNull();
  expect(progressing.textContent).toContain('25 B of 100 B');
  expect(progressing.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('25');
  expect(progressing.querySelector('[role="progressbar"]')!.getAttribute('aria-label')).toBe('Downloading run.zip');
  expect(actions(progressing)).toEqual(['Copy download link']);

  for (const [filename, status, buttons] of [
    ['stop.zip', 'Cancelled', ['Copy download link', 'Remove from list']],
    ['cut.zip', 'Interrupted', ['Retry', 'Copy download link', 'Remove from list']],
  ] as const) {
    const item = row(filename);
    expect(nameLink(item)).toBeNull();
    expect(item.querySelector('.bsp-download-deleted')).toBeNull();
    expect(item.textContent).toContain(status);
    expect(item.querySelector('[role="progressbar"]')).toBeNull();
    expect(actions(item)).toEqual(buttons);
  }
});

it('shows the size of a completed download only when it is known', async () => {
  mocks.getDownloads.mockResolvedValue([completed, { ...completed, id: 'unsized', url: 'https://example.com/u.zip', filename: 'u.zip', totalBytes: 0 }]);
  await mount();
  expect(row('done.zip').querySelector('small')!.textContent).toMatch(/^Completed · 10 B · /);
  const unsized = row('u.zip').querySelector('small')!.textContent!;
  expect(unsized).toMatch(/^Completed · /);
  expect(unsized).not.toContain('0 B');
});

it('offers clear only when there is a finished download to clear', async () => {
  const clearButton = () => [...host.querySelectorAll<HTMLButtonElement>('.bsp-section-head button')].find((button) => button.textContent?.includes('Clear downloads'));
  mocks.getDownloads.mockResolvedValue([{ ...running, active: true }, { ...interrupted, active: true }]);
  await mount();
  expect(clearButton()).toBeUndefined();
  mocks.push!([{ ...running, active: true }, interrupted]);
  await nextTick();
  expect(clearButton()).toBeDefined();
  expect(host.querySelector('.bsp-foot')).toBeNull();
  const head = host.querySelector('.bsp-section-head')!;
  expect(head.querySelector('button[aria-label="Refresh downloads"]')).not.toBeNull();
  expect(clearButton()!.compareDocumentPosition(head.querySelector('button[aria-label="Refresh downloads"]')!) & Node.DOCUMENT_POSITION_PRECEDING).not.toBe(0);

  mocks.clear.mockResolvedValue(snapshot());
  mocks.getDownloads.mockResolvedValue([{ ...running, active: true }]);
  clearButton()!.click();
  await vi.waitFor(() => expect(rows()).toHaveLength(1));
  expect(mocks.clear).toHaveBeenCalledOnce();
  expect(actions(row('run.zip'))).toEqual(['Pause', 'Cancel', 'Copy download link']);
  expect(clearButton()).toBeUndefined();
});

it('renders each date group as its own card', async () => {
  const yesterday = { ...completed, id: 'old', url: 'https://example.com/old.zip', filename: 'old.zip', startedAt: now - 86_400_000 };
  mocks.getDownloads.mockResolvedValue([completed, running, yesterday]);
  await mount();
  const cards = [...host.querySelectorAll<HTMLElement>('.bsp-download-group.settings-group')];
  expect(cards).toHaveLength(2);
  expect(host.querySelector('.bsp-date-group')).toBeNull();
  const [today, earlier] = cards;
  expect(today!.querySelector('.bsp-date-title')!.textContent).toBe('Today');
  expect(today!.querySelectorAll('.bsp-item')).toHaveLength(2);
  expect(today!.textContent).toContain('done.zip');
  expect(today!.textContent).toContain('run.zip');
  expect(today!.textContent).not.toContain('old.zip');
  expect(earlier!.querySelector('.bsp-date-title')!.textContent).toBe('Yesterday');
  expect(earlier!.querySelectorAll('.bsp-item')).toHaveLength(1);
  expect(earlier!.textContent).toContain('old.zip');
  expect(earlier!.textContent).not.toContain('done.zip');
});

it('hides remove while an interrupted download is still active', async () => {
  mocks.getDownloads.mockResolvedValue([{ ...interrupted, active: true }, { ...running, active: true }]);
  await mount();
  expect(row('cut.zip').textContent).toContain('Interrupted');
  expect(actions(row('cut.zip'))).toEqual(['Cancel', 'Copy download link']);
  expect(actions(row('run.zip'))).toEqual(['Pause', 'Cancel', 'Copy download link']);
  mocks.push!([interrupted]);
  await nextTick();
  expect(actions(row('cut.zip'))).toEqual(['Retry', 'Copy download link', 'Remove from list']);
});

it('offers no file actions for a download whose save path was truncated', async () => {
  mocks.getDownloads.mockResolvedValue([{ ...completed, pathTruncated: true }, { ...deleted, pathTruncated: true }]);
  await mount();
  for (const filename of ['done.zip', 'gone.zip']) {
    const item = row(filename);
    expect(nameLink(item)).toBeNull();
    expect(item.querySelector('.bsp-download-deleted')).toBeNull();
    expect(item.textContent).toContain('Completed');
    expect(item.textContent).not.toContain('Deleted');
    expect(actions(item)).toEqual(['Copy download link', 'Remove from list']);
  }
});

it('hides copy download link when the saved link was truncated', async () => {
  mocks.getDownloads.mockResolvedValue([{ ...completed, urlTruncated: true }, { ...cancelled, url: '' }]);
  await mount();
  expect(actions(row('done.zip'))).toEqual(['Show in folder', 'Remove from list']);
  expect(actions(row('stop.zip'))).toEqual(['Remove from list']);
  expect(nameLink(row('done.zip'))).not.toBeNull();
});

it('opens the file from its name, reveals it, copies its link and removes it from the list', async () => {
  mocks.getDownloads.mockResolvedValue([completed, cancelled]);
  mocks.open.mockResolvedValue(true);
  mocks.remove.mockResolvedValue(true);
  await mount();

  nameLink(row('done.zip'))!.click();
  expect(mocks.open).toHaveBeenLastCalledWith('done', 'open');
  row('done.zip').querySelector<HTMLButtonElement>('button[aria-label="Show in folder"]')!.click();
  expect(mocks.open).toHaveBeenLastCalledWith('done', 'show');

  row('stop.zip').querySelector<HTMLButtonElement>('button[aria-label="Copy download link"]')!.click();
  expect(mocks.copy).toHaveBeenCalledExactlyOnceWith('https://example.com/stop.zip');
  await vi.waitFor(() => expect(row('stop.zip').querySelector('button[aria-label="Link copied"]')).not.toBeNull());

  row('stop.zip').querySelector<HTMLButtonElement>('button[aria-label="Remove from list"]')!.click();
  expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('stop');
  await vi.waitFor(() => expect(rows()).toHaveLength(1));
  expect(row('done.zip')).toBeDefined();
});

it('follows live updates from progress to completion', async () => {
  mocks.getDownloads.mockResolvedValue([]);
  await mount();
  mocks.push!([running, { ...running, id: 'unsized', filename: 'unsized.bin', totalBytes: 0 }]);
  await nextTick();
  expect(row('run.zip').querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('25');
  expect(row('unsized.bin').querySelector('[role="progressbar"]')!.hasAttribute('aria-valuenow')).toBe(false);

  mocks.push!([{ ...running, savePath: '/d/run.zip', state: 'completed', receivedBytes: 100, fileMissing: false }]);
  await nextTick();
  expect(rows()).toHaveLength(1);
  expect(row('run.zip').querySelector('[role="progressbar"]')).toBeNull();
  expect(nameLink(row('run.zip'))).not.toBeNull();
  expect(actions(row('run.zip'))).toEqual(['Copy download link', 'Show in folder', 'Remove from list']);
});

it('re-reads file state when an action fails and stops listening on unmount', async () => {
  mocks.getDownloads.mockResolvedValueOnce([completed]);
  mocks.getDownloads.mockResolvedValueOnce([{ ...completed, fileMissing: true }]);
  mocks.open.mockResolvedValue(false);
  await mount();
  nameLink(row('done.zip'))!.click();
  await vi.waitFor(() => expect(row('done.zip').textContent).toContain('Deleted'));
  expect(nameLink(row('done.zip'))).toBeNull();
  expect(mocks.getDownloads).toHaveBeenCalledTimes(2);
  expect(mocks.getData).toHaveBeenCalledOnce();
  app!.unmount();
  app = undefined;
  expect(mocks.off).toHaveBeenCalledOnce();
  expect(mocks.watch).toHaveBeenLastCalledWith(false);
});

it('does not watch downloads or check files while another section is showing', async () => {
  await mount('history');
  window.dispatchEvent(new Event('focus'));
  await nextTick();
  expect(mocks.watch).toHaveBeenCalledExactlyOnceWith(false);
  expect(mocks.getDownloads).not.toHaveBeenCalled();
});

it('re-reads file state when switching into the downloads section', async () => {
  mocks.getDownloads.mockResolvedValueOnce([completed]);
  mocks.getDownloads.mockResolvedValueOnce([{ ...completed, fileMissing: true }]);
  await mount();
  expect(row('done.zip').textContent).toContain('Completed');
  const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  tabs.find((tab) => tab.textContent?.includes('History'))!.click();
  await nextTick();
  expect(mocks.watch).toHaveBeenLastCalledWith(false);
  tabs.find((tab) => tab.textContent?.includes('Downloads'))!.click();
  await vi.waitFor(() => expect(row('done.zip').textContent).toContain('Deleted'));
  expect(mocks.getDownloads).toHaveBeenCalledTimes(2);
  expect(mocks.watch).toHaveBeenLastCalledWith(true);
});

it('shows speed and time left while downloading and hides the time left when it is unknown', async () => {
  mocks.getDownloads.mockResolvedValue([
    { ...running, active: true, receivedBytes: 7_444_889, totalBytes: 74_658_611, speed: 1_258_291 },
    { ...running, id: 'unsized', filename: 'unsized.bin', active: true, receivedBytes: 7_444_889, totalBytes: 0, speed: 1_258_291 },
    { ...running, id: 'stalled', filename: 'stalled.bin', active: true, receivedBytes: 7_444_889, totalBytes: 74_658_611 },
  ]);
  await mount();
  const status = (filename: string) => row(filename).querySelector('small:last-of-type')!.textContent;
  expect(status('run.zip')).toBe('1.2 MB/s - 7.1 MB of 71.2 MB, 53 secs left');
  expect(status('unsized.bin')).toBe('1.2 MB/s - 7.1 MB');
  expect(status('stalled.bin')).toBe('7.1 MB of 71.2 MB');
  mocks.push!([{ ...running, active: true, receivedBytes: 1_048_576, totalBytes: 1_048_576 * 181, speed: 1_048_576 }]);
  await nextTick();
  expect(status('run.zip')).toBe('1.0 MB/s - 1.0 MB of 181 MB, 3 mins left');
  mocks.push!([{ ...running, active: true, receivedBytes: 1_288_490_189, totalBytes: 2_147_483_648, speed: 12_582_912 }]);
  await nextTick();
  expect(status('run.zip')).toBe('12.0 MB/s - 1.2 GB of 2.0 GB, 1 min left');
});

it('offers pause and cancel while downloading and sends them by id', async () => {
  mocks.getDownloads.mockResolvedValue([{ ...running, active: true, speed: 10 }]);
  mocks.open.mockResolvedValue(true);
  await mount();
  const item = row('run.zip');
  expect(actions(item)).toEqual(['Pause', 'Cancel', 'Copy download link']);
  item.querySelector<HTMLButtonElement>('button[aria-label="Pause"]')!.click();
  expect(mocks.open).toHaveBeenLastCalledWith('run', 'pause');
  item.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]')!.click();
  expect(mocks.open).toHaveBeenLastCalledWith('run', 'cancel');
  expect(mocks.getDownloads).toHaveBeenCalledOnce();
});

it('shows a paused download with a frozen bar, resume and cancel across list refreshes', async () => {
  const paused = { ...running, active: true, resumable: true };
  mocks.getDownloads.mockResolvedValue([paused]);
  mocks.open.mockResolvedValue(false);
  await mount();
  const check = () => {
    const item = row('run.zip');
    expect(item.querySelector('small:last-of-type')!.textContent).toBe('Paused - 25 B of 100 B');
    expect(item.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('25');
    expect(item.querySelector('[role="progressbar"]')!.getAttribute('aria-label')).toBe('Paused run.zip');
    expect(item.querySelector('.bsp-progress-paused')).not.toBeNull();
    expect(actions(item)).toEqual(['Resume', 'Cancel', 'Copy download link']);
  };
  check();
  row('run.zip').querySelector<HTMLButtonElement>('button[aria-label="Resume"]')!.click();
  expect(mocks.open).toHaveBeenLastCalledWith('run', 'resume');
  await vi.waitFor(() => expect(mocks.getDownloads).toHaveBeenCalledTimes(2));
  check();
  mocks.push!([paused]);
  await nextTick();
  check();
});

it('offers resume for an interrupted download that can resume and remove once it is cancelled', async () => {
  mocks.getDownloads.mockResolvedValue([{ ...interrupted, active: true, resumable: true }]);
  await mount();
  expect(row('cut.zip').textContent).toContain('Interrupted');
  expect(actions(row('cut.zip'))).toEqual(['Resume', 'Cancel', 'Copy download link']);
  mocks.push!([{ ...interrupted, state: 'cancelled' }]);
  await nextTick();
  expect(row('cut.zip').textContent).toContain('Cancelled');
  expect(actions(row('cut.zip'))).toEqual(['Copy download link', 'Remove from list']);
});

it('keeps the downloaded size after Paused, with or without a known total', async () => {
  const mb = 1_048_576;
  mocks.getDownloads.mockResolvedValue([
    { ...running, active: true, resumable: true, receivedBytes: 43.5 * mb, totalBytes: 397 * mb },
    { ...running, id: 'unsized', filename: 'unsized.bin', active: true, resumable: true, receivedBytes: 43.5 * mb, totalBytes: 0 },
  ]);
  await mount();
  expect(row('run.zip').querySelector('small:last-of-type')!.textContent).toBe('Paused - 43.5 MB of 397 MB');
  expect(row('run.zip').querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('11');
  expect(row('unsized.bin').querySelector('small:last-of-type')!.textContent).toBe('Paused - 43.5 MB');
});

it('retries an interrupted download from before a restart by id and offers no retry without a usable http(s) link', async () => {
  mocks.getDownloads.mockResolvedValue([
    interrupted,
    { ...interrupted, id: 'cut-long', filename: 'long.zip', urlTruncated: true },
    { ...interrupted, id: 'cut-blank', filename: 'blank.zip', url: '' },
    { ...interrupted, id: 'cut-blob', filename: 'blob.bin', url: 'blob:https://example.com/5f0c' },
    { ...interrupted, id: 'cut-data', filename: 'data.txt', url: 'data:text/plain,hi' },
  ]);
  mocks.open.mockResolvedValue(true);
  await mount();
  row('cut.zip').querySelector<HTMLButtonElement>('button[aria-label="Retry"]')!.click();
  expect(mocks.open).toHaveBeenLastCalledWith('cut', 'retry');
  expect(actions(row('long.zip'))).toEqual(['Remove from list']);
  expect(actions(row('blank.zip'))).toEqual(['Remove from list']);
  expect(actions(row('blob.bin'))).toEqual(['Copy download link', 'Remove from list']);
  expect(actions(row('data.txt'))).toEqual(['Copy download link', 'Remove from list']);
  mocks.push!([{ ...interrupted, state: 'progressing', active: true, receivedBytes: 4, totalBytes: 10 }]);
  await nextTick();
  expect(rows()).toHaveLength(1);
  expect(actions(row('cut.zip'))).toEqual(['Pause', 'Cancel', 'Copy download link']);
  expect(row('cut.zip').querySelector('.bsp-download-status')!.textContent).toBe('4 B of 10 B');
});

it('shows the agent control switch first in settings and saves its new value', async () => {
  mocks.getDownloads.mockResolvedValue([]);
  mocks.update.mockResolvedValue({ history: [], preferences: { agentControl: false, subagentControl: false, agentLocalFiles: false, askWhereToSave: false, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] }, defaultUserAgent: 'Mozilla/5.0' });
  await mount('settings');
  const first = host.querySelector('.settings-group .row')!;
  expect(first.textContent).toContain('Let agents control the built-in browser');
  const toggle = first.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  toggle.click();
  expect(mocks.update).toHaveBeenCalledWith({ agentControl: false });
  await vi.waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
});

it('shows default-off subagent control directly below agent control and saves it independently', async () => {
  const data = snapshot();
  mocks.update.mockImplementation(async (patch) => ({ ...data, preferences: { ...data.preferences, ...patch } }));
  await mount('settings');
  const rows = host.querySelectorAll('.settings-group .row');
  const second = rows[1]!;
  expect(rows[0]!.textContent).toContain('Let agents control the built-in browser');
  expect(second.textContent).toContain('Let subagents control the built-in browser');
  expect(second.textContent).toContain('Allow background subagents to use the built-in browser. You can take control whenever needed');
  expect(rows[3]!.textContent).toContain('Default search engine');
  expect(browserZh.settings.subagentControl).toBe('允许 subagent 控制浏览器');
  expect(browserZh.settings.subagentControlHint).toBe('允许后台子智能体使用内置浏览器，你可以随时接管控制权');
  const toggle = second.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(toggle.disabled).toBe(false);
  toggle.click();
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ subagentControl: true });
  await vi.waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
});

it('shows default-off agent local files below subagent control and saves it', async () => {
  const data = snapshot();
  mocks.update.mockImplementation(async (patch) => ({ ...data, preferences: { ...data.preferences, ...patch } }));
  await mount('settings');
  const row = host.querySelectorAll('.settings-group .row')[2]!;
  expect(row.textContent).toContain('Let agents open local files');
  expect(row.textContent).toContain('read any local file the browser can display');
  expect(browserZh.settings.agentLocalFiles).toBe('允许智能体打开本地文件');
  const toggle = row.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  toggle.click();
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ agentLocalFiles: true });
  await vi.waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
});

it('disables subagent control while agent control is off without changing its stored value', async () => {
  const data = snapshot();
  data.preferences.agentControl = false;
  data.preferences.subagentControl = true;
  await mount('settings', data);
  const toggle = host.querySelectorAll('.settings-group .row')[1]!.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(toggle.disabled).toBe(true);
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  toggle.click();
  expect(mocks.update).not.toHaveBeenCalled();
});
