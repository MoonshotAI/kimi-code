import { chmodSync, statSync, utimesSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browserEn } from '@moonshot-ai/app-i18n/browser';
import { getBrowserRecords } from '../../../src/main/app/ui-state';

const mocks = vi.hoisted(() => ({
  hangingPaths: new Set<string>(),
  failingPaths: new Map<string, string>(),
  failingLinkPaths: new Set<string>(),
  delayedStats: new Map<string, { ms: number; exists: boolean }>(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
  preferences: { agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] } as { agentControl: boolean; subagentControl: boolean; agentLocalFiles: boolean; autoplay: 'allow' | 'block'; sound: 'muted' | 'on'; askWhereToSave: boolean; defaultZoomFactor: number; searchEngine: string; customUserAgent: string | null; userAgentPresets: { name: string; value: string }[]; agentDownloadDirectory?: string; agentDownloadLimitBytes?: number | null },
  downloadsAccess: 'unknown' as 'unknown' | 'granted' | 'denied',
  savePreferences: vi.fn(),
  saveRecords: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  mocks.stat.mockImplementation((path: string) => {
    if (mocks.hangingPaths.has(path)) return new Promise(() => {});
    const delayed = mocks.delayedStats.get(path);
    if (delayed !== undefined) {
      return new Promise((resolve, reject) => setTimeout(() => (delayed.exists
        ? resolve({ mode: 0o644, size: 4, isFile: () => true, isDirectory: () => false })
        : reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))), delayed.ms));
    }
    const code = mocks.failingPaths.get(path);
    if (code !== undefined) return Promise.reject(Object.assign(new Error(code), { code }));
    return actual.stat(path);
  });
  mocks.lstat.mockImplementation((path: string) => (mocks.failingLinkPaths.has(path)
    ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    : actual.lstat(path)));
  mocks.realpath.mockImplementation((path: string) => actual.realpath(path));
  return { ...actual, stat: mocks.stat, lstat: mocks.lstat, realpath: mocks.realpath };
});

vi.mock('../../../src/main/browser/browser-user-agent', () => ({
  defaultBrowserUserAgent: () => 'Mozilla/5.0',
  resetCustomBrowserUserAgentCache: vi.fn(),
}));

vi.mock('../../../src/main/app/ui-state', () => ({
  getBrowserPreferences: vi.fn(() => ({ ...mocks.preferences })),
  saveBrowserPreferences: vi.fn((next: typeof mocks.preferences) => {
    mocks.preferences = { ...next };
    mocks.savePreferences(next);
  }),
  getBrowserRecords: vi.fn(() => ({ history: [], downloads: [] })),
  saveBrowserRecords: mocks.saveRecords,
  getBrowserDownloadsAccess: vi.fn(() => mocks.downloadsAccess),
  saveBrowserDownloadsAccess: vi.fn((access: 'granted' | 'denied') => { mocks.downloadsAccess = access; }),
}));

import {
  controlBrowserDownload,
  retryBrowserDownload,
  flushBrowserRecords,
  clearBrowserDownloads,
  clearBrowserHistory,
  getBrowserData,
  getBrowserDownloads,
  EXECUTABLE_DOWNLOAD_EXTENSIONS,
  getBrowserDownloadItems,
  getBrowserFileCheckStateForTest,
  isExecutableDownload,
  onBrowserDownloadsChanged,
  openBrowserDownload,
  readBrowserDownloads,
  recordBrowserHistory,
  refreshBrowserDownloadFiles,
  removeBrowserDownload,
  resetBrowserDataForTest,
  trackBrowserDownload,
  updateBrowserPreferences,
  configureBrowserDownloadsDirectory,
  setBrowserAgentDownloadDirectory,
  noteBrowserDownloadsFailure,
  updateBrowserHistoryFavicon,
} from '../../../src/main/browser/browser-data';

function createDownload(finalPath = '/tmp/file.zip', options: { url?: string; savePath?: string; totalBytes?: number; state?: 'progressing' | 'interrupted' } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let receivedBytes = 10;
  let savePath = options.savePath ?? '';
  let paused = false;
  let state: string = options.state ?? 'progressing';
  const control = { canResume: undefined as boolean | undefined, bytesPerSecond: 0 };
  const item = {
    getURL: () => options.url ?? 'https://example.com/file.zip',
    getURLChain: () => [options.url ?? 'https://example.com/file.zip'],
    getMimeType: () => 'application/zip',
    getETag: () => '"v1"',
    getLastModifiedTime: () => 'Tue, 15 Sep 2026 10:00:00 GMT',
    setSavePath: vi.fn((path: string) => { savePath = path; }),
    getFilename: () => 'file.zip',
    getSavePath: () => savePath,
    getStartTime: () => 1_700_000_000,
    getReceivedBytes: () => receivedBytes,
    getTotalBytes: () => options.totalBytes ?? 100,
    getState: () => state,
    isPaused: () => paused,
    getCurrentBytesPerSecond: () => control.bytesPerSecond,
    canResume: () => control.canResume ?? (paused || state === 'interrupted'),
    pause: vi.fn(() => { paused = true; }),
    resume: vi.fn(() => { paused = false; state = 'progressing'; }),
    cancel: vi.fn(() => { download.done('cancelled'); }),
    on: (event: string, cb: (...args: unknown[]) => void) => handlers.set(event, cb),
    once: (event: string, cb: (...args: unknown[]) => void) => handlers.set(event, cb),
  };
  const download = {
    item,
    control,
    update(bytes: number, next: 'progressing' | 'interrupted' = 'progressing') {
      receivedBytes = bytes;
      state = next;
      handlers.get('updated')?.({}, next);
    },
    done(next: 'completed' | 'cancelled' | 'interrupted') {
      savePath = finalPath;
      state = next;
      handlers.get('done')?.({}, next);
    },
  };
  return download;
}

function clearDownloads() {
  expect(clearBrowserDownloads()).not.toHaveProperty('downloads');
  return getBrowserDownloads();
}

describe('browser data', () => {
  it('persists late favicons without creating visits or forgetting them on a revisit', () => {
    const url = 'https://example.com/';
    recordBrowserHistory({ url, title: 'Example' });
    const before = getBrowserData().history[0]!;
    const favicon = 'data:image/png;base64,AA==';
    updateBrowserHistoryFavicon(url, favicon);
    expect(getBrowserData().history[0]).toMatchObject({ id: before.id, visitedAt: before.visitedAt, favicon });
    recordBrowserHistory({ url, title: 'Example again' });
    expect(getBrowserData().history[0]?.favicon).toBe(favicon);
    clearBrowserHistory();
    updateBrowserHistoryFavicon(url, favicon);
    expect(getBrowserData().history).toEqual([]);
  });
  beforeEach(() => {
    resetBrowserDataForTest();
    mocks.preferences = { agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] };
    vi.clearAllMocks();
  });

  it('records bounded history and updates the latest matching visit', () => {
    recordBrowserHistory({ url: 'https://example.com/', title: 'Example' });
    recordBrowserHistory({
      url: 'https://example.com/',
      title: 'Example Domain',
      favicon: 'https://example.com/favicon.ico',
    });
    expect(getBrowserData().history).toHaveLength(1);
    expect(getBrowserData().history[0]).toMatchObject({
      url: 'https://example.com/',
      title: 'Example Domain',
      favicon: 'https://example.com/favicon.ico',
    });
    expect(clearBrowserHistory().history).toEqual([]);
    expect(mocks.saveRecords).toHaveBeenCalled();
  });

  it('bounds persisted page metadata and omits oversized data-url favicons', () => {
    recordBrowserHistory({
      url: 'https://example.com/',
      title: 'T'.repeat(2_000),
      favicon: `data:image/png;base64,${'A'.repeat(20_000)}`,
    });
    expect(getBrowserData().history[0]).toMatchObject({
      url: 'https://example.com/',
      title: 'T'.repeat(512),
    });
    expect(getBrowserData().history[0]).not.toHaveProperty('favicon');

    recordBrowserHistory({
      url: `https://example.com/${'x'.repeat(5_000)}`,
      title: 'Too long',
    });
    expect(getBrowserData().history).toHaveLength(1);
  });

  it('marks unfinished persisted downloads interrupted while preserving their metadata', async () => {
    const unfinished = {
      id: 'old-download', url: 'https://example.com/file.zip', filename: 'file.zip',
      savePath: '/tmp/file.zip', state: 'progressing' as const,
      startedAt: 1_700_000_000_000, receivedBytes: 25, totalBytes: 100,
    };
    vi.mocked(getBrowserRecords).mockReturnValueOnce({ history: [], downloads: [unfinished] });
    vi.resetModules();
    const fresh = await import('../../../src/main/browser/browser-data');
    const before = Date.now();
    const restored = fresh.getBrowserDownloads();
    expect(restored).toEqual([{ ...unfinished, state: 'interrupted', endedAt: expect.any(Number) }]);
    expect(restored[0]?.endedAt).toBeGreaterThanOrEqual(before);
    expect(mocks.saveRecords).toHaveBeenCalledWith({ history: [], downloads: [{ ...unfinished, state: 'interrupted', endedAt: restored[0]?.endedAt }] });
    const current = createDownload();
    fresh.trackBrowserDownload(current.item as never);
    expect(fresh.getBrowserDownloads()[0]?.state).toBe('progressing');
    current.update(50);
    expect(fresh.getBrowserDownloads()[0]?.receivedBytes).toBe(50);
  });

  it('tracks download progress and completion', () => {
    const download = createDownload();
    trackBrowserDownload(download.item as never);
    expect(getBrowserDownloads()[0]).toMatchObject({
      filename: 'file.zip',
      state: 'progressing',
      receivedBytes: 10,
    });
    download.update(50);
    expect(getBrowserDownloads()[0]?.receivedBytes).toBe(50);
    expect(getBrowserDownloads()[0]?.endedAt).toBeUndefined();
    const before = Date.now();
    download.done('completed');
    expect(getBrowserDownloads()[0]).toMatchObject({
      state: 'completed',
      savePath: '/tmp/file.zip',
    });
    expect(getBrowserDownloads()[0]?.endedAt).toBeGreaterThanOrEqual(before);
    expect(mocks.saveRecords).toHaveBeenLastCalledWith(expect.objectContaining({ downloads: [expect.objectContaining({ endedAt: getBrowserDownloads()[0]?.endedAt })] }));
    expect(clearDownloads()).toEqual([]);
  });

  it('keeps downloads that are still running when the list is cleared', () => {
    const finished = createDownload();
    trackBrowserDownload(finished.item as never);
    finished.done('cancelled');
    const download = createDownload();
    trackBrowserDownload(download.item as never);
    const id = getBrowserDownloads()[0]!.id;
    download.update(30, 'interrupted');
    expect(clearDownloads().map((entry) => entry.id)).toEqual([id]);
    expect(mocks.saveRecords).toHaveBeenLastCalledWith(expect.objectContaining({ downloads: [expect.objectContaining({ id })] }));
    const later = createDownload();
    trackBrowserDownload(later.item as never);
    download.update(50);
    download.done('completed');
    expect(getBrowserDownloads()).toHaveLength(2);
    expect(getBrowserDownloads().find((entry) => entry.id === id)).toMatchObject({ state: 'completed', receivedBytes: 50 });
    later.update(75);
    expect(getBrowserDownloads()[0]?.receivedBytes).toBe(75);
    expect(clearDownloads()).toHaveLength(1);
    later.done('completed');
    expect(clearDownloads()).toEqual([]);
  });

  it('evicts the oldest finished download before any that is still running', () => {
    const running = createDownload();
    trackBrowserDownload(running.item as never);
    const runningId = getBrowserDownloads()[0]!.id;
    const finished: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const download = createDownload();
      trackBrowserDownload(download.item as never);
      finished.push(getBrowserDownloads()[0]!.id);
      download.done('completed');
    }
    const ids = getBrowserDownloads().map((entry) => entry.id);
    expect(ids).toHaveLength(100);
    expect(ids).toContain(runningId);
    expect(ids).not.toContain(finished[0]);
    running.update(90);
    running.done('completed');
    expect(getBrowserDownloads().find((entry) => entry.id === runningId)).toMatchObject({ state: 'completed', receivedBytes: 90 });
  });

  it('does not reinsert a download evicted from the bounded history', () => {
    const oldest = createDownload();
    trackBrowserDownload(oldest.item as never);
    for (let index = 0; index < 100; index += 1) trackBrowserDownload(createDownload().item as never);
    const retained = getBrowserDownloads();
    oldest.done('completed');
    expect(getBrowserDownloads()).toEqual(retained);
  });

  it('replaces saved user agent presets only with a valid list', () => {
    const presets = [{ name: 'Staging', value: 'Custom/1.0' }];
    expect(updateBrowserPreferences({ userAgentPresets: presets }).preferences.userAgentPresets).toEqual(presets);
    expect(updateBrowserPreferences({ userAgentPresets: [...presets, { name: 'STAGING', value: 'Other/1.0' }] }).preferences.userAgentPresets).toEqual(presets);
    expect(updateBrowserPreferences({ askWhereToSave: false }).preferences.userAgentPresets).toEqual(presets);
    expect(updateBrowserPreferences({ userAgentPresets: [] }).preferences.userAgentPresets).toEqual([]);
  });

  it('persists validated browser preferences', () => {
    const next = updateBrowserPreferences({ agentControl: false, subagentControl: false, agentLocalFiles: false, askWhereToSave: false, defaultZoomFactor: 1.25, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] });
    expect(next.preferences).toEqual({ agentControl: false, subagentControl: false, agentLocalFiles: false, askWhereToSave: false, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1.25, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] });
    expect(mocks.savePreferences).toHaveBeenCalledWith(next.preferences);
  });

  it('persists only fixed autoplay values', () => {
    expect(updateBrowserPreferences({ autoplay: 'allow' }).preferences.autoplay).toBe('allow');
    expect(updateBrowserPreferences({ autoplay: 'https://example.test/media' } as never).preferences.autoplay).toBe('allow');
    expect(updateBrowserPreferences({ autoplay: 'block' }).preferences.autoplay).toBe('block');
  });

  it('updates subagent control without rewriting it through the main browser toggle', () => {
    mocks.preferences.subagentControl = true;
    expect(updateBrowserPreferences({ agentControl: false }).preferences).toMatchObject({ agentControl: false, subagentControl: true });
    expect(updateBrowserPreferences({ subagentControl: false }).preferences).toMatchObject({ agentControl: false, subagentControl: false });
    expect(updateBrowserPreferences({ subagentControl: true }).preferences).toMatchObject({ agentControl: false, subagentControl: true });
  });

  it('resolves the agent download location from Downloads access and a custom folder', () => {
    mocks.downloadsAccess = 'unknown';
    configureBrowserDownloadsDirectory(() => '/Users/me/Downloads');
    expect(getBrowserData().agentDownloads).toEqual({ path: '/Users/me/Downloads', custom: false, fallback: false, access: 'unknown' });
    mocks.downloadsAccess = 'denied';
    expect(getBrowserData().agentDownloads).toMatchObject({ custom: false, fallback: true, access: 'denied' });
    const custom = setBrowserAgentDownloadDirectory('/Volumes/Work/agent');
    expect(custom.agentDownloads).toMatchObject({ path: '/Volumes/Work/agent', custom: true, fallback: false });
    const limited = updateBrowserPreferences({ agentDownloadLimitBytes: 500 * 1_024 ** 2 });
    expect(limited.preferences).toMatchObject({ agentDownloadDirectory: '/Volumes/Work/agent', agentDownloadLimitBytes: 500 * 1_024 ** 2 });
    const reset = updateBrowserPreferences({ agentDownloadDirectory: null, agentDownloadLimitBytes: null });
    expect(reset.preferences).not.toHaveProperty('agentDownloadDirectory');
    expect(reset.preferences.agentDownloadLimitBytes).toBeNull();
    expect(reset.agentDownloads).toMatchObject({ custom: false, fallback: true });
  });

  it('switches agent downloads to the fallback folder when granted Downloads access stops working', () => {
    configureBrowserDownloadsDirectory(() => '/Users/me/Downloads');
    updateBrowserPreferences({ agentDownloadDirectory: null });
    mocks.downloadsAccess = 'granted';
    noteBrowserDownloadsFailure(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
    expect(getBrowserData().agentDownloads).toMatchObject({ path: '/Users/me/Downloads', fallback: false, access: 'granted' });
    noteBrowserDownloadsFailure(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    expect(getBrowserData().agentDownloads).toMatchObject({ custom: false, fallback: true, access: 'denied' });
    mocks.downloadsAccess = 'granted';
    setBrowserAgentDownloadDirectory('/Volumes/Work/agent');
    noteBrowserDownloadsFailure(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    expect(mocks.downloadsAccess).toBe('granted');
    updateBrowserPreferences({ agentDownloadDirectory: null });
  });
});

it('coalesces progress writes and immediately persists download completion', () => {
  vi.useFakeTimers();
  resetBrowserDataForTest();
  mocks.saveRecords.mockClear();
  try {
    const download = createDownload();
    trackBrowserDownload(download.item as never);
    for (let i = 0; i < 50; i++) download.update(i);
    expect(getBrowserDownloads()[0]?.receivedBytes).toBe(49);
    expect(mocks.saveRecords).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    expect(mocks.saveRecords).toHaveBeenCalledTimes(2);
    download.update(100);
    download.done('completed');
    expect(mocks.saveRecords).toHaveBeenCalledTimes(3);
    expect(mocks.saveRecords).toHaveBeenLastCalledWith(expect.objectContaining({ downloads: [expect.objectContaining({ state: 'completed', receivedBytes: 100 })] }));
    vi.advanceTimersByTime(250);
    expect(mocks.saveRecords).toHaveBeenCalledTimes(3);
    const pending = createDownload();
    trackBrowserDownload(pending.item as never);
    pending.update(77);
    flushBrowserRecords();
    expect(mocks.saveRecords).toHaveBeenLastCalledWith(expect.objectContaining({ downloads: expect.arrayContaining([expect.objectContaining({ receivedBytes: 77 })]) }));
  } finally { resetBrowserDataForTest(); vi.useRealTimers(); }
});

it('coalesces frequent history visits while keeping history immediately readable', () => {
  vi.useFakeTimers();
  resetBrowserDataForTest();
  mocks.saveRecords.mockClear();
  try {
    for (let i = 0; i < 50; i++) recordBrowserHistory({ url: 'https://example.com/route', title: String(i) });
    expect(getBrowserData().history).toHaveLength(1);
    expect(getBrowserData().history[0]?.title).toBe('49');
    expect(mocks.saveRecords).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(mocks.saveRecords).toHaveBeenCalledOnce();
    recordBrowserHistory({ url: 'https://example.com/next', title: 'Next' });
    flushBrowserRecords();
    expect(mocks.saveRecords).toHaveBeenCalledTimes(2);
  } finally { resetBrowserDataForTest(); vi.useRealTimers(); }
});

it('notifies download changes immediately on start and finish and throttles progress', () => {
  vi.useFakeTimers();
  resetBrowserDataForTest();
  try {
    const listener = vi.fn();
    const off = onBrowserDownloadsChanged(listener);
    const download = createDownload();
    trackBrowserDownload(download.item as never);
    expect(listener).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) download.update(i);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(listener).toHaveBeenCalledTimes(2);
    download.update(60);
    download.done('completed');
    expect(listener).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(200);
    expect(listener).toHaveBeenCalledTimes(3);
    clearBrowserDownloads();
    expect(listener).toHaveBeenCalledTimes(4);
    off();
    trackBrowserDownload(createDownload().item as never);
    expect(listener).toHaveBeenCalledTimes(4);
  } finally { resetBrowserDataForTest(); vi.useRealTimers(); }
});

describe('download files', () => {
  let directory: string;
  const shell = { openPath: vi.fn(async (_path: string) => ''), showItemInFolder: vi.fn() };
  const showMessageBox = vi.fn(async (_options: Electron.MessageBoxOptions) => 0);
  const deps = { shell, showMessageBox, strings: () => browserEn.downloads, platform: 'darwin' as NodeJS.Platform };

  beforeEach(() => {
    resetBrowserDataForTest();
    mocks.hangingPaths.clear();
    mocks.failingPaths.clear();
    mocks.failingLinkPaths.clear();
    mocks.delayedStats.clear();
    directory = mkdtempSync(join(tmpdir(), 'kimi-downloads-'));
    shell.openPath.mockClear();
    shell.openPath.mockResolvedValue('');
    shell.showItemInFolder.mockClear();
    showMessageBox.mockReset();
    showMessageBox.mockResolvedValue(0);
    return () => rmSync(directory, { recursive: true, force: true });
  });

  function completed(name: string, write = true) {
    const path = join(directory, name);
    if (write) writeFileSync(path, 'data');
    const download = createDownload(path);
    trackBrowserDownload(download.item as never);
    download.done('completed');
    return { id: getBrowserDownloads()[0]!.id, path };
  }

  function missing(id: string): boolean | undefined {
    return getBrowserDownloadItems().find((entry) => entry.id === id)?.fileMissing;
  }

  it('flags completed downloads whose file is gone without touching plain snapshots', async () => {
    const present = completed('present.zip');
    const gone = completed('gone.zip');
    await refreshBrowserDownloadFiles();
    rmSync(gone.path);
    const running = createDownload(join(directory, 'running.zip'));
    trackBrowserDownload(running.item as never);
    await expect(refreshBrowserDownloadFiles()).resolves.toBe(true);
    expect(missing(present.id)).toBe(false);
    expect(missing(gone.id)).toBe(true);
    expect(getBrowserDownloadItems()[0]).not.toHaveProperty('fileMissing');
    expect(getBrowserDownloads().some((entry) => 'fileMissing' in entry)).toBe(false);
    await expect(refreshBrowserDownloadFiles()).resolves.toBe(false);
  });

  it('marks a download deleted only when its path is known not to exist', async () => {
    const denied = completed('denied.zip');
    const io = completed('io.zip');
    const notDir = completed('not-dir.zip');
    const gone = completed('gone.zip');
    await refreshBrowserDownloadFiles();
    mocks.failingPaths.set(denied.path, 'EACCES');
    mocks.failingPaths.set(io.path, 'EIO');
    mocks.failingPaths.set(notDir.path, 'ENOTDIR');
    rmSync(gone.path);
    await refreshBrowserDownloadFiles();
    expect(missing(denied.id)).toBe(false);
    expect(missing(io.id)).toBe(false);
    expect(missing(notDir.id)).toBe(true);
    expect(missing(gone.id)).toBe(true);
    await expect(openBrowserDownload({ id: denied.id, action: 'show' }, deps)).resolves.toBe(true);
    expect(missing(denied.id)).toBe(false);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: 'error', message: '“denied.zip” couldn’t be opened', detail: browserEn.downloads.openFailedDialog.detail,
    }));
  });

  it('checks only the finished download and never stats on progress ticks', async () => {
    completed('older.zip');
    await refreshBrowserDownloadFiles();
    const listener = vi.fn();
    onBrowserDownloadsChanged(listener);
    mocks.stat.mockClear();
    const path = join(directory, 'new.zip');
    const download = createDownload(path);
    vi.useFakeTimers();
    try {
      trackBrowserDownload(download.item as never);
      for (let i = 0; i < 20; i++) download.update(i);
      vi.advanceTimersByTime(1_000);
      expect(mocks.stat).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
    listener.mockClear();
    download.done('completed');
      expect(listener).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(mocks.stat).toHaveBeenCalledExactlyOnceWith(path);
    expect(missing(getBrowserDownloads()[0]!.id)).toBe(true);
  });

  it('times out hung file checks and does not stack new ones on the same path', async () => {
    const present = completed('present.zip');
    const hung = completed('hung.zip');
    await refreshBrowserDownloadFiles();
    vi.useFakeTimers();
    try {
      mocks.hangingPaths.add(hung.path);
      rmSync(present.path);
      mocks.stat.mockClear();
      const first = refreshBrowserDownloadFiles();
      const second = refreshBrowserDownloadFiles();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.stat).toHaveBeenCalledTimes(2);
      const presentIndex = mocks.stat.mock.calls.findIndex(([path]) => path === present.path);
      await (mocks.stat.mock.results[presentIndex]!.value as Promise<unknown>).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(first).resolves.toBe(true);
      await expect(second).resolves.toBe(false);
      expect(missing(present.id)).toBe(true);
      expect(missing(hung.id)).toBe(false);
      expect(mocks.stat.mock.calls.filter(([path]) => path === hung.path)).toHaveLength(1);
      const open = openBrowserDownload({ id: hung.id, action: 'open' }, deps);
      await vi.advanceTimersByTimeAsync(0);
      await expect(open).resolves.toBe(true);
      expect(showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        type: 'error', detail: browserEn.downloads.openFailedDialog.unavailable,
      }));
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(mocks.stat.mock.calls.filter(([path]) => path === hung.path)).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('removes one finished entry from the list without touching the file on disk', async () => {
    const kept = completed('kept.zip');
    const removed = completed('removed.zip');
    await refreshBrowserDownloadFiles();
    const running = createDownload(join(directory, 'running.zip'));
    trackBrowserDownload(running.item as never);
    const runningId = getBrowserDownloads()[0]!.id;
    const listener = vi.fn();
    onBrowserDownloadsChanged(listener);
    mocks.saveRecords.mockClear();

    expect(removeBrowserDownload('download-unknown')).toBe(false);
    expect(removeBrowserDownload(runningId)).toBe(false);
    expect(getBrowserDownloads()).toHaveLength(3);
    expect(listener).not.toHaveBeenCalled();
    expect(mocks.saveRecords).not.toHaveBeenCalled();

    expect(removeBrowserDownload(removed.id)).toBe(true);
    expect(getBrowserDownloads().map((entry) => entry.id)).toEqual([runningId, kept.id]);
    expect(mocks.saveRecords).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      downloads: [expect.objectContaining({ id: runningId }), expect.objectContaining({ id: kept.id })],
    }));
    expect(listener).toHaveBeenCalledOnce();
    expect(existsSync(removed.path)).toBe(true);
    expect(readFileSync(removed.path, 'utf8')).toBe('data');
    expect(removeBrowserDownload(removed.id)).toBe(false);
  });

  it('keeps a temporarily interrupted download that is still live in the list', () => {
    const download = createDownload(join(directory, 'flaky.zip'));
    trackBrowserDownload(download.item as never);
    const id = getBrowserDownloads()[0]!.id;
    download.update(40, 'interrupted');
    expect(getBrowserDownloads()[0]).toMatchObject({ id, state: 'interrupted' });
    expect(getBrowserDownloadItems()[0]).toMatchObject({ id, state: 'interrupted', active: true });
    expect(getBrowserDownloads()[0]).not.toHaveProperty('active');
    expect(removeBrowserDownload(id)).toBe(false);
    download.update(60);
    expect(getBrowserDownloads()[0]).toMatchObject({ id, state: 'progressing', receivedBytes: 60 });
    download.done('interrupted');
    expect(getBrowserDownloadItems()[0]).not.toHaveProperty('active');
    expect(mocks.saveRecords.mock.calls.every(([records]) => records.downloads.every((entry: object) => !('active' in entry)))).toBe(true);
    expect(removeBrowserDownload(id)).toBe(true);
    expect(getBrowserDownloads()).toEqual([]);
  });

  it('frees background slots on timeout so hung paths cannot starve other checks or opens', async () => {
    const present = completed('present.zip');
    const other = completed('other.zip');
    const hung = [completed('hung-1.zip'), completed('hung-2.zip')];
    await refreshBrowserDownloadFiles();
    for (const entry of hung) mocks.hangingPaths.add(entry.path);
    rmSync(other.path);
    await refreshBrowserDownloadFiles([other.id]);
    expect(missing(other.id)).toBe(true);
    writeFileSync(other.path, 'data');
    const settle = async (done: () => boolean): Promise<void> => {
      for (let turn = 0; turn < 10_000 && !done(); turn += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.stat.mockClear();
      const stuck = refreshBrowserDownloadFiles(hung.map((entry) => entry.id));
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.stat).toHaveBeenCalledTimes(2);

      let revealed: boolean | undefined;
      void openBrowserDownload({ id: present.id, action: 'show' }, deps).then((value) => { revealed = value; });
      let checked: boolean | undefined;
      void refreshBrowserDownloadFiles([other.id]).then((value) => { checked = value; });
      await settle(() => revealed !== undefined);
      expect(revealed).toBe(true);
      expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(present.path);
      expect(checked).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(stuck).resolves.toBe(false);
      await settle(() => checked !== undefined);
      expect(checked).toBe(true);
      expect(missing(other.id)).toBe(false);
      expect(mocks.stat.mock.calls.filter(([path]) => mocks.hangingPaths.has(path))).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('keeps an identity probe counted until every call settles, even after one fails fast', async () => {
    const paths = [1, 2, 3, 4, 5].map((index) => completed(`slow-${index}.pdf`));
    await refreshBrowserDownloadFiles();
    for (const entry of paths) {
      mocks.hangingPaths.add(entry.path);
      mocks.failingLinkPaths.add(entry.path);
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.stat.mockClear();
      const settled = async (outstanding: number): Promise<void> => {
        for (let turn = 0; turn < 10_000 && getBrowserFileCheckStateForTest().outstanding !== outstanding; turn += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(getBrowserFileCheckStateForTest().outstanding).toBe(outstanding);
      };
      for (const [index, entry] of paths.slice(0, 4).entries()) {
        await settled(index);
        const open = openBrowserDownload({ id: entry.id, action: 'show' }, deps);
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(open).resolves.toBe(true);
        expect(mocks.stat).toHaveBeenCalledTimes(index + 1);
        expect(showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ detail: browserEn.downloads.openFailedDialog.unavailable }));
      }
      await settled(4);
      expect(getBrowserFileCheckStateForTest().outstanding).toBe(4);
      expect(mocks.stat).toHaveBeenCalledTimes(4);
      const refused = openBrowserDownload({ id: paths[4]!.id, action: 'show' }, deps);
      await vi.advanceTimersByTimeAsync(0);
      await expect(refused).resolves.toBe(true);
      expect(mocks.stat).toHaveBeenCalledTimes(4);
      expect(getBrowserFileCheckStateForTest().outstanding).toBe(4);
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('returns the list at once and pushes file states as slow checks finish', async () => {
    const entries = Array.from({ length: 100 }, (_, index) => completed(`slow-${index}.zip`, false));
    await refreshBrowserDownloadFiles();
    for (const [index, entry] of entries.entries()) mocks.delayedStats.set(entry.path, { ms: 900, exists: index % 2 === 0 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let elapsed = 0;
      const pushes: number[] = [];
      onBrowserDownloadsChanged(() => { pushes.push(elapsed); });
      const started = performance.now();
      const items = readBrowserDownloads();
      expect(performance.now() - started).toBeLessThan(20);
      expect(items).toHaveLength(100);
      expect(items.every((item) => item.fileMissing === true)).toBe(true);
      let busiest = 0;
      for (; elapsed < 47_000; elapsed += 25) {
        await vi.advanceTimersByTimeAsync(25);
        busiest = Math.max(busiest, getBrowserFileCheckStateForTest().outstanding);
      }
      expect(busiest).toBeLessThanOrEqual(2);
      expect(getBrowserFileCheckStateForTest()).toMatchObject({ tasks: 0, queued: 0, outstanding: 0 });
      expect(pushes.length).toBeGreaterThan(2);
      expect(pushes.length).toBeLessThanOrEqual(46_000 / 200 + 2);
      for (let index = 1; index < pushes.length - 1; index += 1) expect(pushes[index]! - pushes[index - 1]!).toBeGreaterThanOrEqual(200);
      expect(pushes.at(-1)!).toBeGreaterThanOrEqual(44_000);
      const final = getBrowserDownloadItems();
      for (const [index, entry] of entries.entries()) {
        expect(final.find((item) => item.id === entry.id)?.fileMissing).toBe(index % 2 !== 0);
      }
    } finally { vi.useRealTimers(); }
  });

  it('merges overlapping refreshes into one queued task per path', async () => {
    const slow = [1, 2, 3, 4, 5, 6].map((index) => completed(`slow-${index}.zip`));
    await refreshBrowserDownloadFiles();
    for (const entry of slow) mocks.hangingPaths.add(entry.path);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.stat.mockClear();
      const refreshes = Array.from({ length: 5 }, () => refreshBrowserDownloadFiles());
      await vi.advanceTimersByTimeAsync(0);
      expect(getBrowserFileCheckStateForTest()).toMatchObject({ tasks: 6, queued: 4 });
      expect(mocks.stat).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(Promise.all(refreshes)).resolves.toEqual([false, false, false, false, false]);
      expect(getBrowserFileCheckStateForTest()).toMatchObject({ tasks: 0, queued: 0, outstanding: 3, hung: 3 });
      for (const entry of slow) expect(mocks.stat.mock.calls.filter(([path]) => path === entry.path).length).toBeLessThanOrEqual(1);
      await refreshBrowserDownloadFiles();
      expect(mocks.stat).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it('bounds outstanding stats across background and interactive checks', async () => {
    const hung = [1, 2, 3, 4, 5].map((index) => completed(`hung-${index}.zip`));
    await refreshBrowserDownloadFiles();
    for (const entry of hung) mocks.hangingPaths.add(entry.path);
    const hungStats = () => mocks.stat.mock.calls.filter(([path]) => mocks.hangingPaths.has(path)).length;
    vi.useFakeTimers();
    try {
      mocks.stat.mockClear();
      const first = refreshBrowserDownloadFiles();
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(first).resolves.toBe(false);
      expect(hungStats()).toBe(3);
      const second = refreshBrowserDownloadFiles();
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(second).resolves.toBe(false);
      expect(hungStats()).toBe(3);

      const started = mocks.stat.mock.calls.map(([path]) => path);
      const fresh = hung.filter((entry) => !started.includes(entry.path));
      expect(fresh).toHaveLength(2);
      const reserved = openBrowserDownload({ id: fresh[0]!.id, action: 'show' }, deps);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(reserved).resolves.toBe(true);
      expect(hungStats()).toBe(4);

      let refused: boolean | undefined;
      void openBrowserDownload({ id: fresh[1]!.id, action: 'open' }, deps).then((value) => { refused = value; });
      await vi.advanceTimersByTimeAsync(0);
      expect(refused).toBe(true);
      expect(hungStats()).toBe(4);
      expect(showMessageBox).toHaveBeenCalledTimes(2);
      expect(showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
        type: 'error', message: `“${basename(fresh[1]!.path)}” couldn’t be opened`, detail: browserEn.downloads.openFailedDialog.unavailable,
      }));
      for (const entry of hung) expect(missing(entry.id)).toBe(false);
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each(['$&.pdf', "a$'b.pdf", 'a$`b.pdf', '$$1.pdf', "a$'b.sh"])('names %s literally in every dialog', async (name) => {
    const doc = completed(name);
    await refreshBrowserDownloadFiles();
    showMessageBox.mockResolvedValueOnce(1);
    await openBrowserDownload({ id: doc.id, action: 'open' }, deps);
    const message = (showMessageBox.mock.calls.at(-1)![0] as { message: string }).message;
    expect(message).toContain(`“${name}”`);
    expect(message).not.toContain('{name}');
    if (name.endsWith('.sh')) return;
    shell.openPath.mockResolvedValueOnce('No application');
    showMessageBox.mockResolvedValueOnce(0);
    await openBrowserDownload({ id: doc.id, action: 'open' }, deps);
    const failure = (showMessageBox.mock.calls.at(-1)![0] as { message: string }).message;
    expect(failure).toBe(`“${name}” couldn’t be opened`);
  });

  it('asks before opening and opens only on confirmation', async () => {
    const doc = completed('report.pdf');
    showMessageBox.mockResolvedValueOnce(1);
    await expect(openBrowserDownload({ id: doc.id, action: 'open' }, deps)).resolves.toBe(true);
    expect(showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: 'question', message: 'Open “report.pdf”?', detail: browserEn.downloads.openDialog.detail,
      buttons: ['Open', 'Cancel'], defaultId: 0, cancelId: 1,
    }));
    expect(shell.openPath).not.toHaveBeenCalled();

    await expect(openBrowserDownload({ id: doc.id, action: 'open' }, deps)).resolves.toBe(true);
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(doc.path);

    const image = completed('installer.dmg');
    await expect(openBrowserDownload({ id: image.id, action: 'open' }, deps)).resolves.toBe(true);
    expect(shell.openPath).toHaveBeenLastCalledWith(image.path);
    expect(showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'question' }));
  });

  describe('re-checks the file after the confirmation', () => {
    const duringConfirmation = (change: () => void) => {
      showMessageBox.mockImplementationOnce(async () => { change(); return 0; });
    };
    const changedDialog = () => expect.objectContaining({ type: 'error', detail: browserEn.downloads.openFailedDialog.changed });

    it('opens an unchanged file', async () => {
      const doc = completed('same.pdf');
      await refreshBrowserDownloadFiles();
      duringConfirmation(() => {});
      await expect(openBrowserDownload({ id: doc.id, action: 'open' }, deps)).resolves.toBe(true);
      expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(doc.path);
    });

    it.each([
      ['replaced with another file', (path: string) => { unlinkSync(path); writeFileSync(path, 'other content'); }],
      ['rewritten in place', (path: string) => { writeFileSync(path, 'longer data now'); }],
      ['removed', (path: string) => { unlinkSync(path); }],
    ])('does not open a file %s while the dialog was open', async (_label, change) => {
      const doc = completed('report.pdf');
      await refreshBrowserDownloadFiles();
      duringConfirmation(() => change(doc.path));
      await expect(openBrowserDownload({ id: doc.id, action: 'open' }, deps)).resolves.toBe(true);
      expect(showMessageBox).toHaveBeenLastCalledWith(changedDialog());
      expect(shell.openPath).not.toHaveBeenCalled();
    });

    it('does not open a file rewritten with the same size and mtime while the dialog was open', async () => {
      const doc = completed('same-times.pdf');
      utimesSync(doc.path, 1_700_000_000, 1_700_000_000);
      await refreshBrowserDownloadFiles();
      const before = statSync(doc.path);
      duringConfirmation(() => {
        const deadline = Date.now() + 50;
        while (Date.now() < deadline);
        writeFileSync(doc.path, 'DATA');
        utimesSync(doc.path, 1_700_000_000, 1_700_000_000);
        const after = statSync(doc.path);
        expect([after.size, after.mtimeMs, after.ino]).toEqual([before.size, before.mtimeMs, before.ino]);
        expect(after.ctimeMs).not.toBe(before.ctimeMs);
      });
      await expect(openBrowserDownload({ id: doc.id, action: 'open' }, deps)).resolves.toBe(true);
      expect(showMessageBox).toHaveBeenLastCalledWith(changedDialog());
      expect(shell.openPath).not.toHaveBeenCalled();
    });

    it.skipIf(process.platform === 'win32')('does not open a file made executable while the dialog was open', async () => {
      const doc = completed('notes');
      await refreshBrowserDownloadFiles();
      duringConfirmation(() => chmodSync(doc.path, 0o755));
      await expect(openBrowserDownload({ id: doc.id, action: 'open' }, deps)).resolves.toBe(true);
      expect(showMessageBox).toHaveBeenLastCalledWith(changedDialog());
      expect(shell.openPath).not.toHaveBeenCalled();
    });

    it.skipIf(process.platform === 'win32')('does not open through a symlink retargeted while the dialog was open', async () => {
      const first = join(directory, 'first.pdf');
      const second = join(directory, 'second.pdf');
      writeFileSync(first, 'data');
      writeFileSync(second, 'data');
      const link = join(directory, 'link.pdf');
      symlinkSync(first, link);
      const download = createDownload(link);
      trackBrowserDownload(download.item as never);
      download.done('completed');
      await refreshBrowserDownloadFiles();
      const id = getBrowserDownloads()[0]!.id;
      duringConfirmation(() => { unlinkSync(link); symlinkSync(second, link); });
      await expect(openBrowserDownload({ id, action: 'open' }, deps)).resolves.toBe(true);
      expect(showMessageBox).toHaveBeenLastCalledWith(changedDialog());
      expect(shell.openPath).not.toHaveBeenCalled();
    });

    it('reports an unresponsive location when the re-check does not answer', async () => {
      const doc = completed('slow.pdf');
      await refreshBrowserDownloadFiles();
      duringConfirmation(() => mocks.hangingPaths.add(doc.path));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const open = openBrowserDownload({ id: doc.id, action: 'open' }, deps);
        for (let turn = 0; turn < 10_000 && showMessageBox.mock.calls.length < 1; turn += 1) await new Promise((resolve) => setImmediate(resolve));
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(open).resolves.toBe(true);
      } finally { vi.useRealTimers(); }
      expect(showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error', detail: browserEn.downloads.openFailedDialog.unavailable }));
      expect(shell.openPath).not.toHaveBeenCalled();
    });
  });

  it.each(['run.sh', 'Setup.PKG', 'tool.Command', 'script.py'])('never opens the program or script %s', async (name) => {
    const program = completed(name);
    showMessageBox.mockResolvedValueOnce(1);
    await expect(openBrowserDownload({ id: program.id, action: 'open' }, deps)).resolves.toBe(true);
    expect(showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: 'warning', message: `“${name}” is a program or script`, detail: browserEn.downloads.blockedDialog.detail,
      buttons: ['Show in folder', 'OK'], defaultId: 1, cancelId: 1,
    }));
    expect(shell.showItemInFolder).not.toHaveBeenCalled();

    showMessageBox.mockResolvedValueOnce(0);
    await expect(openBrowserDownload({ id: program.id, action: 'open' }, deps)).resolves.toBe(true);
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(program.path);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('never opens a program behind a harmless-looking symlink name', async () => {
    const target = join(directory, 'setup.pkg');
    writeFileSync(target, 'data');
    const link = join(directory, 'doc.pdf');
    symlinkSync(target, link);
    const download = createDownload(link);
    trackBrowserDownload(download.item as never);
    download.done('completed');
    await refreshBrowserDownloadFiles();
    const id = getBrowserDownloads()[0]!.id;
    showMessageBox.mockResolvedValueOnce(0);
    await expect(openBrowserDownload({ id, action: 'open' }, deps)).resolves.toBe(true);
    expect(showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'warning', message: '“doc.pdf” is a program or script' }));
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(link);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('never opens a file with an execute bit', async () => {
    const program = completed('tool');
    await refreshBrowserDownloadFiles();
    chmodSync(program.path, 0o755);
    await expect(openBrowserDownload({ id: program.id, action: 'open' }, deps)).resolves.toBe(true);
    expect(showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'warning' }));
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(program.path);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('tells the user when the system cannot open a confirmed file', async () => {
    const doc = completed('notes.xyz');
    const failure = (detail: string) => expect.objectContaining({
      type: 'error', message: '“notes.xyz” couldn’t be opened', detail, buttons: ['OK'], defaultId: 0, cancelId: 0,
    });
    shell.openPath.mockResolvedValueOnce('No application knows how to open notes.xyz.');
    await expect(openBrowserDownload({ id: doc.id, action: 'open' }, deps)).resolves.toBe(true);
    expect(showMessageBox).toHaveBeenCalledTimes(2);
    expect(showMessageBox).toHaveBeenLastCalledWith(failure('No application knows how to open notes.xyz.'));

    for (const unreadable of ['   ', 'line one\nline two', 'x'.repeat(301)]) {
      shell.openPath.mockResolvedValueOnce(unreadable);
      await expect(openBrowserDownload({ id: doc.id, action: 'open' }, deps)).resolves.toBe(true);
      expect(showMessageBox).toHaveBeenLastCalledWith(failure(browserEn.downloads.openFailedDialog.detail));
    }
    expect(missing(doc.id)).toBe(false);

    showMessageBox.mockClear();
    showMessageBox.mockResolvedValueOnce(1);
    await openBrowserDownload({ id: doc.id, action: 'open' }, deps);
    expect(showMessageBox).toHaveBeenCalledOnce();
  });

  it('opens and reveals only existing files recorded for completed downloads', async () => {
    const present = completed('present.zip');
    await expect(openBrowserDownload({ id: present.id, action: 'open' }, deps)).resolves.toBe(true);
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(present.path);
    await expect(openBrowserDownload({ id: present.id, action: 'show' }, deps)).resolves.toBe(true);
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(present.path);


    const gone = completed('gone.zip', false);
    const cancelled = createDownload(join(directory, 'present.zip'));
    trackBrowserDownload(cancelled.item as never);
    cancelled.done('cancelled');
    const cancelledId = getBrowserDownloads()[0]!.id;
    shell.openPath.mockClear();
    for (const id of [gone.id, cancelledId, 'download-unknown', directory]) {
      await expect(openBrowserDownload({ id, action: 'open' }, deps)).resolves.toBe(false);
      await expect(openBrowserDownload({ id, action: 'show' }, deps)).resolves.toBe(false);
    }
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).toHaveBeenCalledOnce();
    expect(missing(gone.id)).toBe(true);
  });
});

describe('executable download detection', () => {
  const file = (mode = 0o644) => ({ mode, isFile: () => true, isDirectory: () => false });

  it('matches program and script extensions case-insensitively on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const extension of EXECUTABLE_DOWNLOAD_EXTENSIONS.all) {
        expect(isExecutableDownload(`/d/a${extension}`, file(), platform)).toBe(true);
        expect(isExecutableDownload(`/d/a${extension.toUpperCase()}`, file(), platform)).toBe(true);
      }
    }
    expect(isExecutableDownload('/d/Installer.Pkg', file(), 'darwin')).toBe(true);
  });

  it('covers every Python script and bytecode form on every platform', () => {
    for (const name of ['tool.py', 'gui.PYW', 'mod.pyc', 'mod.pyo', 'app.pyz', 'app.PyZw']) {
      for (const platform of ['win32', 'darwin', 'linux'] as const) expect(isExecutableDownload(`/d/${name}`, file(), platform)).toBe(true);
    }
    for (const name of ['notes.pyx.txt', 'a.pyd.bak']) expect(isExecutableDownload(`/d/${name}`, file(), 'win32')).toBe(false);
  });

  it('covers Linux packages and launchers on every platform, including multi-part extensions', () => {
    for (const name of ['app.deb', 'app.RPM', 'app.flatpak', 'app.flatpakref', 'repo.flatpakrepo', 'app.snap', 'App.AppImage',
      'setup.run', 'app.desktop', 'app.apk', 'app.xbps', 'app-1.0-1-x86_64.pkg.tar.zst', 'app-1.0-1-x86_64.PKG.TAR.XZ']) {
      for (const platform of ['linux', 'darwin', 'win32'] as const) expect(isExecutableDownload(`/d/${name}`, file(), platform)).toBe(true);
    }
    for (const name of ['source.tar.zst', 'backup.tar.xz', 'notes.debug', 'rerun.txt', 'a.jws']) {
      for (const platform of ['linux', 'darwin', 'win32'] as const) expect(isExecutableDownload(`/d/${name}`, file(), platform)).toBe(false);
    }
  });

  it('covers macOS installers and launchers, and Windows script, help and search launchers', () => {
    for (const name of ['Pane.prefPane', 'Flurry.saver', 'a.qlgenerator', 'a.kext', 'a.osax', 'a.scptd', 'Profile.mobileconfig', 'a.fileloc', 'a.inetloc', 'app.JNLP']) {
      for (const platform of ['darwin', 'linux', 'win32'] as const) expect(isExecutableDownload(`/d/${name}`, file(), platform)).toBe(true);
    }
    for (const name of ['help.CHM', 'setup.inf', 'console.msc', 'a.scf', 'a.sct', 'a.shb', 'a.xll', 'db.accde', 'q.search-ms', 'a.searchConnector-ms', 'a.themepack', 'a.ps1xml']) {
      expect(isExecutableDownload(`C:\\d\\${name}`, file(), 'win32')).toBe(true);
    }
    for (const name of ['photo.webloc', 'cert.crt', 'archive.cab', 'report.pdf']) {
      for (const platform of ['darwin', 'linux', 'win32'] as const) expect(isExecutableDownload(`/d/${name}`, file(), platform)).toBe(false);
    }
  });

  it('covers every Windows type on the Outlook blocked-attachment list that runs or launches on open', () => {
    const outlook = '.ade .adp .apk .app .appcontent-ms .application .appref-ms .appx .bas .bat .bgi .cdxml .chm .cmd .cnt .com .cpl .csh .diagcab .exe .fxp .gadget .grp .hlp .hpj .hta .htc .inf .ins .isp .its .jar .jnlp .js .jse .ksh .library-ms .lnk .mad .maf .mag .mam .maq .mar .mas .mat .mau .mav .maw .mcf .mda .mdb .mde .mdt .mdw .mdz .msc .msh .msh1 .msh2 .mshxml .msh1xml .msh2xml .msi .msp .mst .msu .ops .osd .pcd .pif .pl .plg .prf .prg .printerexport .ps1 .ps1xml .ps2 .ps2xml .psc1 .psc2 .psd1 .psdm1 .pssc .py .pyc .pyo .pyw .pyz .pyzw .reg .scf .scr .sct .search-ms .settingcontent-ms .shb .shs .theme .udl .url .vb .vbe .vbp .vbs .vsmacros .vsw .webpnp .website .ws .wsb .wsc .wsf .wsh .xbap .xll .xnk';
    for (const extension of [...outlook.split(' '), '.ahk', '.au3', '.a3x', '.psm1', '.vbscript', '.rdp']) {
      expect(isExecutableDownload(`C:\\d\\a${extension.toUpperCase()}`, file(), 'win32'), extension).toBe(true);
    }
    for (const extension of ['.cer', '.crt', '.der', '.cab', '.pst', '.tmp', '.asp', '.aspx', '.asx', '.mht', '.mhtml', '.img', '.iso', '.vhd', '.vhdx']) {
      expect(isExecutableDownload(`C:\\d\\a${extension}`, file(), 'win32'), extension).toBe(false);
    }
  });

  it('covers modern Windows installers, launchers and shortcut formats', () => {
    for (const name of ['App.msix', 'App.MSIXBUNDLE', 'App.appx', 'App.appxbundle', 'App.appinstaller', 'App.application', 'App.appref-ms',
      'fix.msp', 'fix.mst', 'old.pif', 'w.gadget', 'a.vbe', 'a.jse', 'a.wsh', 'a.psc1', 'a.ws', 'a.SettingContent-ms', 'a.diagcab',
      'a.library-ms', 'site.url', 'site.website', 'app.xbap']) {
      expect(isExecutableDownload(`C:\\d\\${name}`, file(), 'win32')).toBe(true);
    }
  });

  it('matches Windows executables only on Windows', () => {
    for (const extension of EXECUTABLE_DOWNLOAD_EXTENSIONS.windows) {
      expect(isExecutableDownload(`C:\\d\\a${extension.toUpperCase()}`, file(), 'win32')).toBe(true);
      expect(isExecutableDownload(`/d/a${extension}`, file(), 'darwin')).toBe(false);
    }
  });

  it('leaves documents and disk images alone', () => {
    for (const name of ['report.pdf', 'photo.JPG', 'archive.zip', 'installer.dmg', 'notes.txt', 'README']) {
      for (const platform of ['darwin', 'linux', 'win32'] as const) expect(isExecutableDownload(`/d/${name}`, file(), platform)).toBe(false);
    }
  });

  it('treats the execute bit as executable outside Windows', () => {
    expect(isExecutableDownload('/d/tool', file(0o755), 'darwin')).toBe(true);
    expect(isExecutableDownload('/d/tool', file(0o744), 'linux')).toBe(true);
    expect(isExecutableDownload('/d/tool', file(0o755), 'win32')).toBe(false);
    expect(isExecutableDownload('/d/Thing.bundle', { mode: 0o755, isFile: () => false, isDirectory: () => true }, 'darwin')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('reads the execute bit from a real file', async () => {
    const { stat } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const directory = mkdtempSync(join(tmpdir(), 'kimi-exec-'));
    try {
      const path = join(directory, 'tool');
      writeFileSync(path, '#!/bin/sh\n');
      expect(isExecutableDownload(path, await stat(path), process.platform)).toBe(false);
      chmodSync(path, 0o755);
      expect(isExecutableDownload(path, await stat(path), process.platform)).toBe(true);
      const bundle = join(directory, 'Thing.app');
      mkdirSync(bundle);
      expect(isExecutableDownload(bundle, await stat(bundle), process.platform)).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

it('never uses a truncated save path for file checks or actions', async () => {
  resetBrowserDataForTest();
  const { BROWSER_RECORD_PATH_MAX } = await import('../../../src/shared/browser-data');
  const { asBrowserDownloadEntry } = await import('../../../src/shared/browser-data-records');
  const directory = mkdtempSync(join(tmpdir(), 'kimi-long-path-'));
  try {
    const cut = join(directory, 'x'.repeat(8));
    writeFileSync(cut, 'data');
    const longPath = `${cut}${'/y'.repeat(BROWSER_RECORD_PATH_MAX)}`;
    const download = createDownload(longPath);
    trackBrowserDownload({ ...download.item, getSavePath: () => longPath } as never);
    download.done('completed');
    const entry = getBrowserDownloads()[0]!;
    expect(entry).toMatchObject({ pathTruncated: true, state: 'completed' });
    expect(entry.savePath).toHaveLength(BROWSER_RECORD_PATH_MAX);
    mocks.stat.mockClear();
    await expect(refreshBrowserDownloadFiles()).resolves.toBe(false);
    const shell = { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() };
    const showMessageBox = vi.fn(async () => 0);
    for (const action of ['open', 'show'] as const) {
      await expect(openBrowserDownload({ id: entry.id, action }, { shell, showMessageBox, strings: () => browserEn.downloads })).resolves.toBe(false);
    }
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(getBrowserDownloadItems()[0]).not.toHaveProperty('fileMissing');

    const stored = { id: 'old', url: 'u', filename: 'a', savePath: '/d/a', state: 'completed', startedAt: 1, receivedBytes: 1, totalBytes: 1 };
    expect(asBrowserDownloadEntry(stored)).toEqual(stored);
    expect(asBrowserDownloadEntry({ ...stored, pathTruncated: false })).toEqual(stored);
    expect(asBrowserDownloadEntry({ ...stored, pathTruncated: true })).toEqual({ ...stored, pathTruncated: true });
    const { savePath: _savePath, ...withoutPath } = stored;
    expect(asBrowserDownloadEntry({ ...withoutPath, pathTruncated: true })).toEqual(withoutPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    resetBrowserDataForTest();
  }
});

it('records when a download URL had to be truncated and reads older records as complete', async () => {
  resetBrowserDataForTest();
  const { BROWSER_RECORD_URL_MAX } = await import('../../../src/shared/browser-data');
  const { asBrowserDownloadEntry } = await import('../../../src/shared/browser-data-records');
  const long = `https://example.com/file.zip?sig=${'x'.repeat(BROWSER_RECORD_URL_MAX)}`;
  const download = createDownload();
  trackBrowserDownload({ ...download.item, getURL: () => long } as never);
  expect(getBrowserDownloads()[0]).toMatchObject({ url: long.slice(0, BROWSER_RECORD_URL_MAX), urlTruncated: true });
  const exact = createDownload();
  trackBrowserDownload({ ...exact.item, getURL: () => `https://e.com/${'y'.repeat(BROWSER_RECORD_URL_MAX - 14)}` } as never);
  expect(getBrowserDownloads()[0]!.url).toHaveLength(BROWSER_RECORD_URL_MAX);
  expect(getBrowserDownloads()[0]).toMatchObject({ urlTruncated: false });
  expect(asBrowserDownloadEntry(getBrowserDownloads()[0])).toMatchObject({ urlTruncated: false });
  trackBrowserDownload(createDownload().item as never);
  expect(getBrowserDownloads()[0]).not.toHaveProperty('urlTruncated');

  const stored = { id: 'old', url: 'https://example.com/a', filename: 'a', state: 'completed', startedAt: 1, receivedBytes: 1, totalBytes: 1 };
  expect(asBrowserDownloadEntry(stored)).toEqual(stored);
  expect(asBrowserDownloadEntry({ ...stored, urlTruncated: false })).toEqual(stored);
  expect(asBrowserDownloadEntry({ ...stored, urlTruncated: true })).toEqual({ ...stored, urlTruncated: true });
  expect(asBrowserDownloadEntry({ ...stored, urlTruncated: 'yes' })).toBeNull();
  resetBrowserDataForTest();
});

it('treats legacy records cut at the old cap without a flag as truncated', async () => {
  const { BROWSER_RECORD_URL_MAX, BROWSER_RECORD_PATH_MAX } = await import('../../../src/shared/browser-data');
  const { asBrowserDownloadEntry } = await import('../../../src/shared/browser-data-records');
  const base = { id: 'legacy', filename: 'a', state: 'completed', startedAt: 1, receivedBytes: 1, totalBytes: 1 };
  const url = (length: number) => `https://e.com/${'u'.repeat(length - 14)}`;
  const path = (length: number) => `/${'p'.repeat(length - 1)}`;

  const atCap = asBrowserDownloadEntry({ ...base, url: url(BROWSER_RECORD_URL_MAX), savePath: path(BROWSER_RECORD_PATH_MAX) });
  expect(atCap).toMatchObject({ urlTruncated: true, pathTruncated: true });

  const below = asBrowserDownloadEntry({ ...base, url: url(BROWSER_RECORD_URL_MAX - 1), savePath: path(BROWSER_RECORD_PATH_MAX - 1) });
  expect(below).not.toHaveProperty('urlTruncated');
  expect(below).not.toHaveProperty('pathTruncated');

  const explicit = asBrowserDownloadEntry({ ...base, url: url(BROWSER_RECORD_URL_MAX), urlTruncated: false, savePath: path(BROWSER_RECORD_PATH_MAX), pathTruncated: false });
  expect(explicit).toMatchObject({ urlTruncated: false, pathTruncated: false });
  expect(asBrowserDownloadEntry(explicit)).toEqual(explicit);

  vi.mocked(getBrowserRecords).mockReturnValueOnce({ history: [], downloads: [atCap!] });
  vi.resetModules();
  const fresh = await import('../../../src/main/browser/browser-data');
  const [loaded] = fresh.getBrowserDownloadItems();
  expect(loaded).toMatchObject({ urlTruncated: true, pathTruncated: true });
  mocks.stat.mockClear();
  await expect(fresh.refreshBrowserDownloadFiles()).resolves.toBe(false);
  expect(mocks.stat).not.toHaveBeenCalled();
});

describe('download controls', () => {
  beforeEach(() => {
    resetBrowserDataForTest();
    vi.clearAllMocks();
  });

  it('reports Chromium\'s current speed instead of averaging bytes since tracking started', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const download = createDownload();
      trackBrowserDownload(download.item as never);
      const id = getBrowserDownloadItems()[0]!.id;
      const mb = 1_048_576;
      download.update(2 * mb);
      expect(getBrowserDownloadItems()[0]).not.toHaveProperty('speed');
      const samples = [
        { after: 500, received: 150 * mb, speed: 5.4 * mb },
        { after: 1_000, received: 155.3 * mb, speed: 5.3 * mb },
        { after: 1_000, received: 160.5 * mb, speed: 5.2 * mb },
        { after: 1_000, received: 165.6 * mb, speed: 5.1 * mb },
      ];
      for (const sample of samples) {
        vi.advanceTimersByTime(sample.after);
        download.control.bytesPerSecond = sample.speed;
        download.update(sample.received);
        expect(getBrowserDownloadItems()[0]).toMatchObject({ id, active: true, speed: Math.round(sample.speed) });
      }

      download.control.bytesPerSecond = Number.NaN;
      expect(getBrowserDownloadItems()[0]).not.toHaveProperty('speed');
      download.control.bytesPerSecond = 5.1 * mb;
      expect(controlBrowserDownload({ id, action: 'pause' })).toBe(true);
      expect(download.item.pause).toHaveBeenCalledOnce();
      download.update(165.6 * mb);
      expect(getBrowserDownloadItems()[0]).toMatchObject({ id, state: 'progressing', active: true, resumable: true });
      expect(getBrowserDownloadItems()[0]).not.toHaveProperty('speed');
      expect(getBrowserDownloads()[0]).not.toHaveProperty('resumable');
      download.update(170 * mb, 'interrupted');
      expect(getBrowserDownloadItems()[0]).not.toHaveProperty('speed');
    } finally { vi.useRealTimers(); }
  });

  it('pauses, resumes and cancels only live downloads and notifies the list', () => {
    const download = createDownload();
    trackBrowserDownload(download.item as never);
    const id = getBrowserDownloadItems()[0]!.id;
    const listener = vi.fn();
    onBrowserDownloadsChanged(listener);

    expect(controlBrowserDownload({ id, action: 'resume' })).toBe(false);
    expect(download.item.resume).not.toHaveBeenCalled();
    expect(controlBrowserDownload({ id, action: 'pause' })).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(controlBrowserDownload({ id, action: 'pause' })).toBe(false);
    expect(download.item.pause).toHaveBeenCalledOnce();
    expect(controlBrowserDownload({ id, action: 'resume' })).toBe(true);
    expect(download.item.resume).toHaveBeenCalledOnce();
    expect(getBrowserDownloadItems()[0]).not.toHaveProperty('resumable');

    expect(controlBrowserDownload({ id, action: 'cancel' })).toBe(true);
    expect(download.item.cancel).toHaveBeenCalledOnce();
    const [cancelled] = getBrowserDownloadItems();
    expect(cancelled).toMatchObject({ id, state: 'cancelled' });
    expect(cancelled).not.toHaveProperty('active');
    for (const action of ['pause', 'resume', 'cancel'] as const) {
      expect(controlBrowserDownload({ id, action })).toBe(false);
      expect(controlBrowserDownload({ id: 'download-unknown', action })).toBe(false);
    }
    expect(download.item.cancel).toHaveBeenCalledOnce();
    expect(removeBrowserDownload(id)).toBe(true);
  });

  it('offers resume for an interrupted download only while Electron can resume it', () => {
    const download = createDownload();
    trackBrowserDownload(download.item as never);
    const id = getBrowserDownloadItems()[0]!.id;
    download.update(40, 'interrupted');
    expect(getBrowserDownloadItems()[0]).toMatchObject({ id, state: 'interrupted', active: true, resumable: true });
    expect(controlBrowserDownload({ id, action: 'pause' })).toBe(false);

    download.control.canResume = false;
    expect(getBrowserDownloadItems()[0]).not.toHaveProperty('resumable');
    expect(controlBrowserDownload({ id, action: 'resume' })).toBe(false);
    expect(download.item.resume).not.toHaveBeenCalled();

    download.control.canResume = undefined;
    expect(controlBrowserDownload({ id, action: 'resume' })).toBe(true);
    download.update(50);
    expect(getBrowserDownloadItems()[0]).toMatchObject({ id, state: 'progressing', active: true });
  });

  it('keeps persisted downloads from an earlier run out of reach', async () => {
    const stale = { id: 'old', url: 'https://example.com/a', filename: 'a', state: 'progressing' as const, startedAt: 1, receivedBytes: 1, totalBytes: 2 };
    vi.mocked(getBrowserRecords).mockReturnValueOnce({ history: [], downloads: [stale] });
    vi.resetModules();
    const fresh = await import('../../../src/main/browser/browser-data');
    expect(fresh.getBrowserDownloadItems()[0]).toEqual({ ...stale, state: 'interrupted', endedAt: expect.any(Number) });
    expect(fresh.controlBrowserDownload({ id: 'old', action: 'resume' })).toBe(false);
    expect(fresh.controlBrowserDownload({ id: 'old', action: 'cancel' })).toBe(false);
  });
});

describe('download retry', () => {
  let directory: string;
  const url = 'https://example.com/app.dmg';
  const mb = 1_048_576;
  const session = () => ({ createInterruptedDownload: vi.fn(), downloadURL: vi.fn() });
  const allowHttp = (value: string) => value.startsWith('https://') || value.startsWith('http://');

  beforeEach(() => {
    resetBrowserDataForTest();
    vi.clearAllMocks();
    directory = mkdtempSync(join(tmpdir(), 'download-retry-'));
  });

  async function restored(overrides: Record<string, unknown> = {}, partialBytes = 43 * mb) {
    const savePath = join(directory, 'app.dmg');
    if (partialBytes > 0) writeFileSync(savePath, Buffer.alloc(partialBytes));
    const record = {
      id: 'download-old', url, filename: 'app.dmg', savePath, state: 'progressing', startedAt: 1_758_000_000_000,
      receivedBytes: 43 * mb, totalBytes: 397 * mb,
      resume: { urlChain: [url, 'https://cdn.example.com/app.dmg'], mimeType: 'application/x-apple-diskimage', eTag: '"abc"', lastModified: 'Tue, 15 Sep 2026 10:00:00 GMT' },
      ...overrides,
    };
    vi.mocked(getBrowserRecords).mockReturnValueOnce({ history: [], downloads: [record as never] });
    vi.resetModules();
    return { fresh: await import('../../../src/main/browser/browser-data'), savePath, record };
  }

  it('resumes a live interrupted download that Electron can resume', async () => {
    const download = createDownload();
    trackBrowserDownload(download.item as never);
    const id = getBrowserDownloadItems()[0]!.id;
    const deps = { session: session(), isAllowedUrl: allowHttp };
    expect(await retryBrowserDownload(id, deps)).toBe(false);
    download.update(40, 'interrupted');
    download.control.canResume = false;
    expect(await retryBrowserDownload(id, deps)).toBe(false);
    download.control.canResume = undefined;
    expect(await retryBrowserDownload(id, deps)).toBe(true);
    expect(download.item.resume).toHaveBeenCalledOnce();
    expect(deps.session.createInterruptedDownload).not.toHaveBeenCalled();
    expect(deps.session.downloadURL).not.toHaveBeenCalled();
  });

  it('keeps resume metadata in the saved record but not in the renderer or automation lists', () => {
    const download = createDownload('/tmp/file.zip', { savePath: '/tmp/file.zip' });
    trackBrowserDownload(download.item as never);
    download.update(40, 'interrupted');
    flushBrowserRecords();
    const saved = mocks.saveRecords.mock.calls.at(-1)![0].downloads[0];
    expect(saved).toMatchObject({ state: 'interrupted', resume: { urlChain: ['https://example.com/file.zip'], eTag: '"v1"', mimeType: 'application/zip' } });
    expect(getBrowserDownloadItems()[0]).not.toHaveProperty('resume');
    expect(getBrowserDownloads()[0]).not.toHaveProperty('resume');
    download.done('completed');
    expect(mocks.saveRecords.mock.calls.at(-1)![0].downloads[0]).not.toHaveProperty('resume');
  });

  it('recreates a download from before a restart and resumes it into the same row', async () => {
    const { fresh, savePath, record } = await restored();
    const deps = { session: session(), isAllowedUrl: allowHttp };
    expect(await fresh.retryBrowserDownload('download-old', deps)).toBe(true);
    expect(deps.session.downloadURL).not.toHaveBeenCalled();
    expect(deps.session.createInterruptedDownload).toHaveBeenCalledExactlyOnceWith({
      path: savePath, urlChain: record.resume.urlChain, mimeType: 'application/x-apple-diskimage',
      offset: 43 * mb, length: 397 * mb, lastModified: record.resume.lastModified, eTag: '"abc"', startTime: 1_758_000_000,
    });
    expect(await fresh.retryBrowserDownload('download-old', deps)).toBe(false);

    const created = createDownload(savePath, { url: 'https://cdn.example.com/app.dmg', savePath, totalBytes: 397 * mb, state: 'interrupted' });
    const samePageDownload = createDownload(savePath, { url: 'https://cdn.example.com/app.dmg', savePath, state: 'interrupted' });
    expect(fresh.claimBrowserDownloadRetry(samePageDownload.item as never, true)).toBeUndefined();
    const sameUrlRestart = createDownload(savePath, { url, savePath });
    expect(fresh.claimBrowserDownloadRetry(sameUrlRestart.item as never, false)).toBeUndefined();
    const unrelated = createDownload('/tmp/other.dmg', { url: 'https://example.com/other.dmg' });
    expect(fresh.claimBrowserDownloadRetry(unrelated.item as never, false)).toBeUndefined();
    const claim = fresh.claimBrowserDownloadRetry(created.item as never, false);
    expect(claim).toEqual({ id: 'download-old', resume: true, savePath });
    expect(fresh.claimBrowserDownloadRetry(created.item as never, false)).toBeUndefined();
    fresh.trackBrowserDownload(created.item as never, claim!.id);
    const items = fresh.getBrowserDownloadItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'download-old', state: 'progressing', active: true, startedAt: record.startedAt, savePath });
    created.update(50 * mb);
    created.done('completed');
    expect(fresh.getBrowserDownloadItems()).toEqual([expect.objectContaining({ id: 'download-old', state: 'completed' })]);
  });

  it('restarts from the URL into the same path when the download cannot resume', async () => {
    for (const [overrides, partial] of [
      [{}, 0],
      [{}, 1_024],
      [{ resume: { urlChain: [url] } }, 43 * mb],
      [{ resume: undefined }, 43 * mb],
    ] as const) {
      resetBrowserDataForTest();
      const { fresh, savePath } = await restored(overrides, partial);
      const deps = { session: session(), isAllowedUrl: allowHttp };
      expect(await fresh.retryBrowserDownload('download-old', deps)).toBe(true);
      expect(deps.session.createInterruptedDownload).not.toHaveBeenCalled();
      expect(deps.session.downloadURL).toHaveBeenCalledExactlyOnceWith(url);
      const restarted = createDownload(savePath, { url, totalBytes: 397 * mb });
      expect(fresh.claimBrowserDownloadRetry(restarted.item as never, false)).toEqual({ id: 'download-old', resume: false, savePath });
      rmSync(savePath, { force: true });
    }
  });

  it('does not let a page download of the same URL or a second retry take over a pending retry', async () => {
    const savePath = join(directory, 'app.dmg');
    const { fresh } = await restored({ savePath, resume: undefined }, 0);
    const deps = { session: session(), isAllowedUrl: allowHttp };
    expect(await fresh.retryBrowserDownload('download-old', deps)).toBe(true);
    const pageDownload = createDownload(savePath, { url });
    expect(fresh.claimBrowserDownloadRetry(pageDownload.item as never, true)).toBeUndefined();
    fresh.trackBrowserDownload(pageDownload.item as never);
    expect(fresh.getBrowserDownloadItems().map((entry) => entry.id)).toEqual([expect.stringMatching(/^download-\d/), 'download-old']);
    const retried = createDownload(savePath, { url });
    expect(fresh.claimBrowserDownloadRetry(retried.item as never, false)).toEqual({ id: 'download-old', resume: false, savePath });
  });

  it('refuses a second retry for the same URL while one is pending', async () => {
    const second = { id: 'download-second', url, filename: 'app (1).dmg', state: 'interrupted', startedAt: 2, receivedBytes: 1, totalBytes: 2 };
    vi.mocked(getBrowserRecords).mockReturnValueOnce({ history: [], downloads: [
      { id: 'download-old', url, filename: 'app.dmg', state: 'interrupted', startedAt: 1, receivedBytes: 1, totalBytes: 2 },
      second,
    ] as never });
    vi.resetModules();
    const fresh = await import('../../../src/main/browser/browser-data');
    const deps = { session: session(), isAllowedUrl: allowHttp };
    expect(await fresh.retryBrowserDownload('download-old', deps)).toBe(true);
    expect(await fresh.retryBrowserDownload('download-second', deps)).toBe(false);
    expect(deps.session.downloadURL).toHaveBeenCalledOnce();
    const restarted = createDownload('/tmp/app.dmg', { url });
    expect(fresh.claimBrowserDownloadRetry(restarted.item as never, false)).toEqual({ id: 'download-old', resume: false });
    expect(await fresh.retryBrowserDownload('download-second', deps)).toBe(true);
  });

  it('refuses a retry that races another one past the file probe', async () => {
    const { fresh } = await restored();
    const deps = { session: session(), isAllowedUrl: allowHttp };
    const results = await Promise.all([fresh.retryBrowserDownload('download-old', deps), fresh.retryBrowserDownload('download-old', deps)]);
    expect(results).toEqual([true, false]);
    expect(deps.session.createInterruptedDownload).toHaveBeenCalledOnce();
    expect(deps.session.downloadURL).not.toHaveBeenCalled();
  });

  it('refuses concurrent retries of two records that share a URL', async () => {
    const firstPath = join(directory, 'app.dmg');
    const secondPath = join(directory, 'app (1).dmg');
    writeFileSync(firstPath, Buffer.alloc(64));
    writeFileSync(secondPath, Buffer.alloc(64));
    vi.mocked(getBrowserRecords).mockReturnValueOnce({ history: [], downloads: [
      { id: 'download-old', url, filename: 'app.dmg', savePath: firstPath, state: 'interrupted', startedAt: 1, receivedBytes: 32, totalBytes: 100, resume: { urlChain: [url], eTag: '"a"' } },
      { id: 'download-second', url, filename: 'app (1).dmg', savePath: secondPath, state: 'interrupted', startedAt: 2, receivedBytes: 32, totalBytes: 100, resume: { urlChain: [url], eTag: '"a"' } },
    ] as never });
    vi.resetModules();
    const fresh = await import('../../../src/main/browser/browser-data');
    const deps = { session: session(), isAllowedUrl: allowHttp };
    const results = await Promise.all([fresh.retryBrowserDownload('download-old', deps), fresh.retryBrowserDownload('download-second', deps)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(deps.session.createInterruptedDownload).toHaveBeenCalledOnce();
  });

  it('asks for a location through the normal flow when the old path is unknown', async () => {
    const { fresh } = await restored({ savePath: undefined, resume: undefined }, 0);
    const deps = { session: session(), isAllowedUrl: allowHttp };
    expect(await fresh.retryBrowserDownload('download-old', deps)).toBe(true);
    const restarted = createDownload('/tmp/app.dmg', { url });
    expect(fresh.claimBrowserDownloadRetry(restarted.item as never, false)).toEqual({ id: 'download-old', resume: false });
  });

  it('refuses unknown, finished, non-http and truncated downloads', async () => {
    const deps = { session: session(), isAllowedUrl: allowHttp };
    const { fresh } = await restored({ state: 'completed' });
    expect(await fresh.retryBrowserDownload('download-old', deps)).toBe(false);
    expect(await fresh.retryBrowserDownload('download-unknown', deps)).toBe(false);
    for (const overrides of [{ url: 'file:///etc/passwd' }, { url: `${url}?x`, urlTruncated: true }, { url: '' }]) {
      resetBrowserDataForTest();
      const next = await restored(overrides);
      expect(await next.fresh.retryBrowserDownload('download-old', deps)).toBe(false);
    }
    const unsafeChain = await restored({ resume: { urlChain: ['file:///tmp/app.dmg'], eTag: '"abc"' } });
    expect(await unsafeChain.fresh.retryBrowserDownload('download-old', deps)).toBe(true);
    expect(deps.session.createInterruptedDownload).not.toHaveBeenCalled();
    expect(deps.session.downloadURL).toHaveBeenCalledExactlyOnceWith(url);
  });
});
