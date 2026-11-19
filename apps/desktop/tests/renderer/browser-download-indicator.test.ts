import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, effectScope, h, nextTick } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { ContextRing } from '@moonshot-ai/app-ui';
import type { BrowserDownloadItem } from '../../src/shared/browser-data';

const mocks = vi.hoisted(() => ({
  getDownloads: vi.fn(async (): Promise<BrowserDownloadItem[]> => []),
  watch: vi.fn(),
  off: vi.fn(),
  push: undefined as ((downloads: BrowserDownloadItem[]) => void) | undefined,
}));

vi.mock('../../src/renderer/lib/nativeBrowser', () => ({
  getNativeBrowserBridge: () => ({
    browserGetDownloads: mocks.getDownloads,
    browserWatchDownloads: mocks.watch,
    onBrowserDownloads: (cb: (downloads: BrowserDownloadItem[]) => void) => { mocks.push = cb; return mocks.off; },
  }),
}));

import {
  BROWSER_DOWNLOAD_RETENTION_MS,
  aggregateBrowserDownloadProgress,
  browserDownloadIndicator,
  finishedBrowserDownloads,
  hasUnseenBrowserDownloads,
  nextBrowserDownloadExpiry,
  recentBrowserDownloads,
  setBrowserDownloadsWatch,
  useBrowserDownloads,
} from '../../src/renderer/lib/browserDownloads';

const T0 = new Date('2026-01-01T12:00:00Z').getTime();
const HOUR = BROWSER_DOWNLOAD_RETENTION_MS;

function item(id: string, patch: Partial<BrowserDownloadItem> = {}): BrowserDownloadItem {
  return { id, url: `https://example.com/${id}`, filename: `${id}.zip`, state: 'progressing', startedAt: T0, receivedBytes: 0, totalBytes: 100, active: true, ...patch };
}

describe('download indicator state', () => {
  it('aggregates progress across running downloads and ignores finished ones', () => {
    expect(aggregateBrowserDownloadProgress([])).toEqual({ active: false, value: undefined });
    expect(aggregateBrowserDownloadProgress([
      item('a', { receivedBytes: 25, totalBytes: 100 }),
      item('b', { receivedBytes: 75, totalBytes: 300 }),
      item('c', { state: 'completed', receivedBytes: 999, totalBytes: 999 }),
    ])).toEqual({ active: true, value: 0.25 });
    expect(aggregateBrowserDownloadProgress([item('a', { resumable: true, receivedBytes: 50 })])).toEqual({ active: true, value: 0.5 });
    expect(aggregateBrowserDownloadProgress([item('a'), item('b', { totalBytes: 0 })])).toEqual({ active: true, value: undefined });
  });

  it('keeps running downloads and hides idle ones after the retention window, latest activity first', () => {
    const items = [
      item('old', { state: 'completed', startedAt: T0 - 2 * HOUR, active: undefined }),
      item('slow', { startedAt: T0 - 5 * HOUR }),
      item('recent', { state: 'completed', startedAt: T0 - HOUR / 2, active: undefined }),
      item('ended', { state: 'interrupted', startedAt: T0 - 3 * HOUR, active: undefined }),
    ];
    const ended = new Map([['ended', T0 - 10 * 60_000]]);
    expect(recentBrowserDownloads(items, ended, T0).map((entry) => entry.id)).toEqual(['ended', 'recent', 'slow']);
    expect(recentBrowserDownloads(items, ended, T0 + HOUR).map((entry) => entry.id)).toEqual(['slow']);
    expect(nextBrowserDownloadExpiry(items, ended, T0)).toBe(T0 + HOUR / 2);
    expect(nextBrowserDownloadExpiry([item('slow')], ended, T0)).toBeUndefined();
  });

  it('keeps a long download that finished while nothing was watching by its recorded end time', () => {
    const long = item('long', { state: 'completed', startedAt: T0 - 3 * HOUR, endedAt: T0 - 60_000, active: undefined });
    expect(recentBrowserDownloads([long], new Map(), T0).map((entry) => entry.id)).toEqual(['long']);
    expect(nextBrowserDownloadExpiry([long], new Map(), T0)).toBe(T0 - 60_000 + HOUR);
  });

  it('ranks a just-finished older download ahead of later starts', () => {
    const later = Array.from({ length: 8 }, (_, index) => item(`later${index}`, { state: 'completed', startedAt: T0 - 30_000 + index, active: undefined }));
    const early = item('early', { state: 'completed', startedAt: T0 - HOUR / 2, active: undefined });
    expect(recentBrowserDownloads([...later, early], new Map([['early', T0]]), T0)[0]?.id).toBe('early');
  });

  it('keeps a live interrupted download past the retention window while it can still be resumed', () => {
    const live = item('live', { state: 'interrupted', startedAt: T0 - 3 * HOUR, active: true, resumable: true });
    expect(recentBrowserDownloads([live], new Map(), T0).map((entry) => entry.id)).toEqual(['live']);
    expect(nextBrowserDownloadExpiry([live], new Map(), T0)).toBeUndefined();
  });

  it('stops the indeterminate spinner when unknown-size downloads are paused', () => {
    expect(aggregateBrowserDownloadProgress([item('a', { totalBytes: 0, resumable: true })])).toEqual({ active: true, value: 0 });
    expect(aggregateBrowserDownloadProgress([item('a', { totalBytes: 0, resumable: true }), item('b', { receivedBytes: 50 })])).toEqual({ active: true, value: 0.5 });
    expect(aggregateBrowserDownloadProgress([item('a', { totalBytes: 0, resumable: true }), item('b', { totalBytes: 0 })])).toEqual({ active: true, value: undefined });
  });

  it('treats starts and completions after the last open as unseen', () => {
    const items = [item('a', { state: 'completed', startedAt: T0 - 1_000 })];
    expect(hasUnseenBrowserDownloads(items, new Map(), T0)).toBe(false);
    expect(hasUnseenBrowserDownloads(items, new Map([['a', T0 + 1]]), T0)).toBe(true);
    expect(hasUnseenBrowserDownloads([item('b', { startedAt: T0 + 5 })], new Map(), T0)).toBe(true);
  });

  it('detects downloads that left the running state', () => {
    const previous = [item('a'), item('b'), item('c', { state: 'completed' })];
    const next = [item('a', { state: 'completed' }), item('b'), item('c', { state: 'completed' })];
    expect(finishedBrowserDownloads(previous, next).map((entry) => entry.id)).toEqual(['a']);
  });

  it('detects a resumable interrupted download that completes without a progressing update', () => {
    const interrupted = item('a', { state: 'interrupted', resumable: true });
    expect(finishedBrowserDownloads([interrupted], [item('a', { state: 'completed', active: undefined })]).map((entry) => entry.id)).toEqual(['a']);
    expect(finishedBrowserDownloads([interrupted], [interrupted])).toEqual([]);
    expect(finishedBrowserDownloads([interrupted], [item('a', { state: 'interrupted', active: undefined })])).toEqual([]);
  });
});

describe('download button visuals', () => {
  it('draws the ring only while downloads run and returns to the plain icon when idle or complete', () => {
    expect(browserDownloadIndicator({ active: false, value: undefined })).toEqual({ ring: false, indeterminate: false, pct: 0 });
    expect(browserDownloadIndicator({ active: true, value: 0.4 })).toEqual({ ring: true, indeterminate: false, pct: 40 });
    expect(browserDownloadIndicator({ active: true, value: 1.2 })).toEqual({ ring: true, indeterminate: false, pct: 100 });
    expect(browserDownloadIndicator({ active: true, value: undefined })).toEqual({ ring: true, indeterminate: true, pct: 0 });
  });

  async function ring(props: { pct: number; weight?: 'regular' | 'thin'; indeterminate?: boolean; origin?: boolean }): Promise<string> {
    return renderToString(createSSRApp({ render: () => h(ContextRing, props) }));
  }

  it('renders a thin track with an origin dot that leaves room for the glyph', async () => {
    const html = await ring({ pct: 40, weight: 'thin', origin: true });
    expect(html).toContain('ctx-ring--thin');
    expect(html).toContain('class="ctx-ring-origin"');
    expect(html).toMatch(/class="ctx-ring-track"[^>]*r="9.25"[^>]*stroke-width="1.5"/);
    expect(html).not.toContain('ctx-ring--indeterminate');
    const regular = await ring({ pct: 40 });
    expect(regular).toMatch(/class="ctx-ring-track"[^>]*r="7"[^>]*stroke-width="2.5"/);
    expect(regular).not.toContain('ctx-ring-origin');
  });

  it('draws a fixed arc segment for indeterminate progress that stops spinning under reduced motion', async () => {
    const html = await ring({ pct: 0, weight: 'thin', indeterminate: true });
    expect(html).toContain('ctx-ring--indeterminate');
    const circumference = 2 * Math.PI * 9.25;
    expect(html).toContain(`stroke-dasharray="${circumference * 0.25} ${circumference}"`);
    expect(html).toContain('stroke-dashoffset="0"');
  });
});

describe('shared downloads store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    mocks.getDownloads.mockReset().mockResolvedValue([]);
    mocks.watch.mockClear();
    mocks.off.mockClear();
    mocks.push = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the indicator on start, marks completion unseen, and hides after the retention window', async () => {
    const scope = effectScope();
    const store = scope.run(() => useBrowserDownloads())!;
    expect(mocks.watch).toHaveBeenLastCalledWith(true);
    expect(store.visible.value).toBe(false);

    vi.setSystemTime(T0 + 1_000);
    mocks.push!([item('a', { startedAt: T0 + 1_000, receivedBytes: 40 })]);
    expect(store.visible.value).toBe(true);
    expect(store.unseen.value).toBe(true);
    expect(store.progress.value).toEqual({ active: true, value: 0.4 });

    store.markSeen();
    expect(store.unseen.value).toBe(false);

    vi.setSystemTime(T0 + 60_000);
    mocks.push!([item('a', { startedAt: T0 + 1_000, state: 'completed', receivedBytes: 100, active: undefined })]);
    expect(store.completion.value).toBe(1);
    expect(store.unseen.value).toBe(true);
    expect(store.progress.value.active).toBe(false);
    store.markSeen();

    await vi.advanceTimersByTimeAsync(HOUR - 1_000);
    expect(store.visible.value).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    await nextTick();
    expect(store.visible.value).toBe(false);

    store.release();
    scope.stop();
    expect(mocks.off).toHaveBeenCalledOnce();
    expect(mocks.watch).toHaveBeenLastCalledWith(false);
  });

  it('ranks a retried older download by the retry time, not its original start', () => {
    const scope = effectScope();
    const store = scope.run(() => useBrowserDownloads())!;
    const later = Array.from({ length: 8 }, (_, index) => item(`later${index}`, { state: 'completed', startedAt: T0 - 20 * 60_000 + index, endedAt: T0 - 10 * 60_000 + index, active: undefined }));
    const failed = item('old', { state: 'interrupted', startedAt: T0 - 50 * 60_000, endedAt: T0 - 40 * 60_000, active: undefined });
    mocks.push!([...later, failed]);
    expect(store.recent.value.at(-1)?.id).toBe('old');

    vi.setSystemTime(T0 + 1_000);
    mocks.push!([...later, item('old', { startedAt: T0 - 50 * 60_000 })]);
    expect(store.recent.value[0]?.id).toBe('old');

    store.release();
    scope.stop();
  });

  it('shares one subscription and keeps watching while any owner needs it', async () => {
    mocks.getDownloads.mockResolvedValue([item('a')]);
    const first = useBrowserDownloads();
    const second = useBrowserDownloads();
    await first.refresh();
    expect(second.visible.value).toBe(true);
    const settings = Symbol('settings');
    setBrowserDownloadsWatch(settings, true);
    setBrowserDownloadsWatch(settings, false);
    expect(mocks.watch).toHaveBeenLastCalledWith(true);
    first.release();
    first.release();
    expect(mocks.off).not.toHaveBeenCalled();
    second.release();
    expect(mocks.off).toHaveBeenCalledOnce();
    expect(mocks.watch).toHaveBeenLastCalledWith(false);
  });
});
