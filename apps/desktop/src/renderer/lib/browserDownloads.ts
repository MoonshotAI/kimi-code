import { computed, readonly, ref, shallowRef, type ComputedRef, type Ref } from 'vue';
import type { BrowserDownloadItem } from '../../shared/browser-data';
import { downloadTimeLeftMs, downloadTimeLeftParts, formatDownloadBytes } from '../../shared/browser-download-status';
import { getNativeBrowserBridge } from './nativeBrowser';

export const BROWSER_DOWNLOAD_RETENTION_MS = 60 * 60_000;
export const BROWSER_DOWNLOAD_BUBBLE_LIMIT = 8;
export const BROWSER_DOWNLOAD_AUTO_CLOSE_MS = 5_000;

export type BrowserDownloadTranslate = (key: string, named?: Record<string, unknown>, plural?: number) => string;

export function isPausedDownload(entry: BrowserDownloadItem): boolean {
  return entry.state === 'progressing' && entry.resumable === true;
}

export function canPauseDownload(entry: BrowserDownloadItem): boolean {
  return entry.active === true && entry.state === 'progressing' && entry.resumable !== true;
}

export function canResumeDownload(entry: BrowserDownloadItem): boolean {
  return entry.active === true && entry.resumable === true;
}

export function canCancelDownload(entry: BrowserDownloadItem): boolean {
  return entry.active === true;
}

function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function canCopyDownloadLink(entry: BrowserDownloadItem): boolean {
  return entry.url !== '' && entry.urlTruncated !== true;
}

export function canRetryDownload(entry: BrowserDownloadItem): boolean {
  return entry.state === 'interrupted' && entry.active !== true && canCopyDownloadLink(entry) && isWebUrl(entry.url);
}

export function canOpenDownload(entry: BrowserDownloadItem): boolean {
  return entry.state === 'completed' && entry.savePath !== undefined && entry.pathTruncated !== true && entry.fileMissing !== true;
}

export function canRemoveDownload(entry: BrowserDownloadItem): boolean {
  return entry.state !== 'progressing' && entry.active !== true;
}

export function isDeletedDownload(entry: BrowserDownloadItem): boolean {
  return entry.state === 'completed' && entry.pathTruncated !== true && entry.fileMissing === true;
}

export function downloadProgress(entry: BrowserDownloadItem): number | undefined {
  return entry.totalBytes > 0 ? Math.min(1, entry.receivedBytes / entry.totalBytes) : undefined;
}

export function formatDownloadTime(value: number, locale: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date) : '—';
}

function formatTimeLeft(t: BrowserDownloadTranslate, ms: number): string {
  const { unit, count } = downloadTimeLeftParts(ms);
  return t(`browser.downloads.timeLeft.${unit}`, { n: count }, count);
}

export function downloadProgressStatus(t: BrowserDownloadTranslate, entry: BrowserDownloadItem): string {
  const progress = entry.totalBytes > 0
    ? t('browser.downloads.status.size', { received: formatDownloadBytes(entry.receivedBytes), total: formatDownloadBytes(entry.totalBytes) })
    : formatDownloadBytes(entry.receivedBytes);
  if (isPausedDownload(entry)) return t('browser.downloads.status.paused', { progress });
  const left = downloadTimeLeftMs(entry.receivedBytes, entry.totalBytes, entry.speed);
  const status = left === undefined ? progress : t('browser.downloads.status.timeLeft', { progress, time: formatTimeLeft(t, left) });
  return entry.speed !== undefined && entry.speed > 0
    ? t('browser.downloads.status.speed', { speed: `${formatDownloadBytes(entry.speed)}/s`, status })
    : status;
}

export function downloadStateLabel(t: BrowserDownloadTranslate, entry: BrowserDownloadItem): string {
  return isDeletedDownload(entry) ? t('browser.downloads.fileMissing') : t(`browser.downloads.${entry.state}`);
}

export function downloadStatus(t: BrowserDownloadTranslate, entry: BrowserDownloadItem, locale: string): string {
  if (entry.state === 'progressing') return downloadProgressStatus(t, entry);
  const size = entry.state === 'completed' && entry.totalBytes > 0 ? ` · ${formatDownloadBytes(entry.totalBytes)}` : '';
  return `${downloadStateLabel(t, entry)}${size} · ${formatDownloadTime(entry.startedAt, locale)}`;
}

export function downloadBubbleStatus(t: BrowserDownloadTranslate, entry: BrowserDownloadItem): string {
  if (entry.state === 'progressing') return downloadProgressStatus(t, entry);
  if (entry.state === 'completed' && !isDeletedDownload(entry)) return formatDownloadBytes(entry.totalBytes > 0 ? entry.totalBytes : entry.receivedBytes);
  return downloadStateLabel(t, entry);
}

export type BrowserDownloadEndTimes = ReadonlyMap<string, number>;

export function isDownloadInProgress(entry: BrowserDownloadItem): boolean {
  return entry.state === 'progressing';
}

export function downloadActivityAt(entry: BrowserDownloadItem, endedAt: BrowserDownloadEndTimes): number {
  return Math.max(entry.startedAt, entry.endedAt ?? 0, endedAt.get(entry.id) ?? 0);
}

export function recentBrowserDownloads(
  items: readonly BrowserDownloadItem[],
  endedAt: BrowserDownloadEndTimes,
  now: number,
  retentionMs = BROWSER_DOWNLOAD_RETENTION_MS,
): BrowserDownloadItem[] {
  return items
    .filter((entry) => isDownloadInProgress(entry) || entry.active === true || now - downloadActivityAt(entry, endedAt) < retentionMs)
    .sort((a, b) => downloadActivityAt(b, endedAt) - downloadActivityAt(a, endedAt) || b.startedAt - a.startedAt);
}

export interface BrowserDownloadAggregate {
  active: boolean;
  value: number | undefined;
}

export function aggregateBrowserDownloadProgress(items: readonly BrowserDownloadItem[]): BrowserDownloadAggregate {
  const running = items.filter(isDownloadInProgress);
  if (running.length === 0) return { active: false, value: undefined };
  if (running.some((entry) => entry.totalBytes <= 0 && !isPausedDownload(entry))) return { active: true, value: undefined };
  const total = running.reduce((sum, entry) => sum + entry.totalBytes, 0);
  const received = running.reduce((sum, entry) => sum + Math.min(entry.receivedBytes, entry.totalBytes), 0);
  return { active: true, value: total > 0 ? received / total : 0 };
}

export interface BrowserDownloadIndicator {
  ring: boolean;
  indeterminate: boolean;
  pct: number;
}

export function browserDownloadIndicator(progress: BrowserDownloadAggregate): BrowserDownloadIndicator {
  if (!progress.active) return { ring: false, indeterminate: false, pct: 0 };
  if (progress.value === undefined) return { ring: true, indeterminate: true, pct: 0 };
  return { ring: true, indeterminate: false, pct: Math.min(1, Math.max(0, progress.value)) * 100 };
}

export function hasUnseenBrowserDownloads(items: readonly BrowserDownloadItem[], endedAt: BrowserDownloadEndTimes, seenAt: number): boolean {
  return items.some((entry) => downloadActivityAt(entry, endedAt) > seenAt);
}

export function nextBrowserDownloadExpiry(
  items: readonly BrowserDownloadItem[],
  endedAt: BrowserDownloadEndTimes,
  now: number,
  retentionMs = BROWSER_DOWNLOAD_RETENTION_MS,
): number | undefined {
  let next: number | undefined;
  for (const entry of items) {
    if (isDownloadInProgress(entry) || entry.active === true) continue;
    const expiry = downloadActivityAt(entry, endedAt) + retentionMs;
    if (expiry > now && (next === undefined || expiry < next)) next = expiry;
  }
  return next;
}

export function finishedBrowserDownloads(previous: readonly BrowserDownloadItem[], next: readonly BrowserDownloadItem[]): BrowserDownloadItem[] {
  const live = new Map(previous.filter((entry) => isDownloadInProgress(entry) || entry.active === true).map((entry) => [entry.id, entry.state]));
  return next.filter((entry) => live.has(entry.id) && !isDownloadInProgress(entry) && live.get(entry.id) !== entry.state);
}

export function startedBrowserDownloads(previous: readonly BrowserDownloadItem[], next: readonly BrowserDownloadItem[]): BrowserDownloadItem[] {
  const running = new Set(previous.filter(isDownloadInProgress).map((entry) => entry.id));
  return next.filter((entry) => isDownloadInProgress(entry) && !running.has(entry.id));
}

const watchOwners = new Set<symbol>();

export function setBrowserDownloadsWatch(owner: symbol, watch: boolean): void {
  if (watch) watchOwners.add(owner);
  else watchOwners.delete(owner);
  getNativeBrowserBridge()?.browserWatchDownloads(watchOwners.size > 0);
}

export interface BrowserDownloadsStore {
  items: Readonly<Ref<readonly BrowserDownloadItem[]>>;
  recent: ComputedRef<BrowserDownloadItem[]>;
  progress: ComputedRef<BrowserDownloadAggregate>;
  unseen: ComputedRef<boolean>;
  visible: ComputedRef<boolean>;
  completion: Readonly<Ref<number>>;
  markSeen: () => void;
  refresh: () => Promise<void>;
  release: () => void;
}

interface SharedDownloads {
  items: Ref<readonly BrowserDownloadItem[]>;
  endedAt: Ref<ReadonlyMap<string, number>>;
  seenAt: Ref<number>;
  now: Ref<number>;
  completion: Ref<number>;
  users: number;
  owner: symbol;
  revision: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  off: (() => void) | undefined;
}

let shared: SharedDownloads | null = null;

function scheduleExpiry(state: SharedDownloads): void {
  clearTimeout(state.timer);
  state.timer = undefined;
  const now = Date.now();
  state.now.value = now;
  const next = nextBrowserDownloadExpiry(state.items.value, state.endedAt.value, now);
  if (next === undefined) return;
  state.timer = setTimeout(() => scheduleExpiry(state), Math.max(1_000, next - now + 50));
}

function adopt(state: SharedDownloads, next: readonly BrowserDownloadItem[]): void {
  const now = Date.now();
  const finished = finishedBrowserDownloads(state.items.value, next);
  const known = new Set(next.map((entry) => entry.id));
  const endedAt = new Map([...state.endedAt.value].filter(([id]) => known.has(id)));
  for (const entry of finished) endedAt.set(entry.id, now);
  const previous = new Set(state.items.value.map((entry) => entry.id));
  for (const entry of startedBrowserDownloads(state.items.value, next)) {
    if (previous.has(entry.id)) endedAt.set(entry.id, now);
    else endedAt.delete(entry.id);
  }
  state.endedAt.value = endedAt;
  state.items.value = next;
  if (finished.some((entry) => entry.state === 'completed')) state.completion.value += 1;
  scheduleExpiry(state);
}

export function useBrowserDownloads(): BrowserDownloadsStore {
  const bridge = getNativeBrowserBridge();
  if (shared === null) {
    const state: SharedDownloads = {
      items: shallowRef([]),
      endedAt: shallowRef(new Map()),
      seenAt: ref(Date.now()),
      now: ref(Date.now()),
      completion: ref(0),
      users: 0,
      owner: Symbol('browser-downloads'),
      revision: 0,
      timer: undefined,
      off: undefined,
    };
    shared = state;
    state.off = bridge?.onBrowserDownloads((next) => {
      state.revision += 1;
      adopt(state, next);
    });
    if (bridge !== null) setBrowserDownloadsWatch(state.owner, true);
  }
  const state = shared;
  state.users += 1;
  let released = false;

  async function refresh(): Promise<void> {
    if (bridge === null) return;
    const revision = state.revision;
    const next = await bridge.browserGetDownloads().catch(() => null);
    if (next !== null && revision === state.revision && shared === state) adopt(state, next);
  }

  function release(): void {
    if (released) return;
    released = true;
    state.users -= 1;
    if (state.users > 0 || shared !== state) return;
    shared = null;
    clearTimeout(state.timer);
    state.off?.();
    if (bridge !== null) setBrowserDownloadsWatch(state.owner, false);
  }

  const recent = computed(() => recentBrowserDownloads(state.items.value, state.endedAt.value, state.now.value));
  const progress = computed(() => aggregateBrowserDownloadProgress(state.items.value));
  const unseen = computed(() => hasUnseenBrowserDownloads(recent.value, state.endedAt.value, state.seenAt.value));
  return {
    items: readonly(state.items),
    recent,
    progress,
    unseen,
    visible: computed(() => recent.value.length > 0),
    completion: readonly(state.completion),
    markSeen: () => { state.seenAt.value = Date.now(); },
    refresh,
    release,
  };
}
