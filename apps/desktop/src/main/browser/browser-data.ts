import { log } from '../diagnostics/log';
import { isBrowserSearchEngine } from '../../shared/browser-search';
import { isBrowserAutoplay } from '../../shared/browser-autoplay';
import { isBrowserSound } from '../../shared/browser-sound';
import { isBrowserCustomUserAgent, isBrowserUserAgentSavedPresets } from '../../shared/browser-user-agent';
import { defaultBrowserUserAgent, resetCustomBrowserUserAgentCache } from './browser-user-agent';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { downloadsAccessFromError, probeDownloadsAccess, probeDownloadsAccessSync, resolveAgentDownloadLocation } from './browser-agent-downloads';
import type { Stats } from 'node:fs';
import type { DownloadItem, MessageBoxOptions, Session, Shell } from 'electron';

import {
  BROWSER_DOWNLOAD_URL_CHAIN_MAX,
  asBrowserDownloadEntry,
  asBrowserHistoryEntry,
  persistableBrowserFavicon,
  type BrowserDownloadRecord,
  type BrowserDownloadResume,
} from '../../shared/browser-data-records';
import {
  BROWSER_RECORD_FILENAME_MAX,
  BROWSER_RECORD_PATH_MAX,
  BROWSER_RECORD_TITLE_MAX,
  BROWSER_RECORD_URL_MAX,
  type BrowserAgentDownloadLocation,
  type BrowserDataSnapshot,
  type BrowserDownloadAction,
  type BrowserDownloadControl,
  type BrowserDownloadEntry,
  type BrowserDownloadItem,
  type BrowserHistoryEntry,
  type BrowserPreferences,
  type BrowserPreferencesPatch,
} from '../../shared/browser-data';
import {
  getBrowserDownloadsAccess,
  getBrowserPreferences,
  getBrowserRecords,
  saveBrowserDownloadsAccess,
  saveBrowserPreferences,
  saveBrowserRecords,
} from '../app/ui-state';

const MAX_HISTORY = 200;
const MAX_DOWNLOADS = 100;
let historySequence = 0;
let downloadSequence = 0;
let history: BrowserHistoryEntry[] = [];
let downloads: BrowserDownloadRecord[] = [];
let recordsLoaded = false;
let recordsTimer: ReturnType<typeof setTimeout> | undefined;
const DOWNLOAD_PROGRESS_INTERVAL_MS = 200;
const DOWNLOAD_FILE_CHECK_TIMEOUT_MS = 1_000;
const downloadListeners = new Set<() => void>();
const downloadFileMissing = new Map<string, boolean>();
const activeDownloads = new Map<string, DownloadItem>();
type FileProbe = { stats: Stats; link?: Stats; real?: string };
type FileStatResult = FileProbe | { error: unknown };
const BACKGROUND_FILE_CHECK_SLOTS = 2;
const BACKGROUND_FS_CALL_LIMIT = 3;
const MAX_OUTSTANDING_FS_CALLS = 6;
const IDENTITY_PROBE_CALLS = 3;
const fileTasks = new Map<string, Promise<FileStatResult | undefined>>();
const hungFileKeys = new Set<string>();
let outstandingFsCalls = 0;
let outstandingBackgroundFsCalls = 0;
let fsCallGeneration = 0;
let backgroundSlotsInUse = 0;
const backgroundSlotWaiters: Array<() => void> = [];

function identityKey(path: string): string {
  return `\0identity:${path}`;
}

function countedFsCall<T>(call: () => Promise<T>, background = false): Promise<T> {
  outstandingFsCalls += 1;
  if (background) outstandingBackgroundFsCalls += 1;
  const generation = fsCallGeneration;
  const running = call();
  const settle = (): void => {
    if (generation !== fsCallGeneration) return;
    outstandingFsCalls -= 1;
    if (background) outstandingBackgroundFsCalls -= 1;
  };
  void running.then(settle, settle);
  return running;
}

function backgroundStatProbe(path: string): Promise<FileStatResult> {
  return countedFsCall(() => stat(path), true).then((stats): FileStatResult => ({ stats }), (error: unknown): FileStatResult => ({ error }));
}

async function identityProbe(path: string): Promise<FileStatResult> {
  const [stats, link, real] = await Promise.allSettled([
    countedFsCall(() => stat(path)), countedFsCall(() => lstat(path)), countedFsCall(() => realpath(path)),
  ]);
  if (stats.status === 'rejected') return { error: stats.reason };
  if (link.status === 'rejected') return { error: link.reason };
  if (real.status === 'rejected') return { error: real.reason };
  return { stats: stats.value, link: link.value, real: real.value };
}

function withTimeout(key: string, probe: Promise<FileStatResult>): Promise<FileStatResult | undefined> {
  void probe.then(() => { hungFileKeys.delete(key); });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      hungFileKeys.add(key);
      resolve(undefined);
    }, DOWNLOAD_FILE_CHECK_TIMEOUT_MS);
    timer.unref?.();
    void probe.then((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

function isHung(path: string): boolean {
  return hungFileKeys.has(path) || hungFileKeys.has(identityKey(path));
}

function registerFileTask(key: string, task: Promise<FileStatResult | undefined>): Promise<FileStatResult | undefined> {
  fileTasks.set(key, task);
  void task.then(() => { if (fileTasks.get(key) === task) fileTasks.delete(key); });
  return task;
}

async function acquireBackgroundSlot(): Promise<void> {
  if (backgroundSlotsInUse >= BACKGROUND_FILE_CHECK_SLOTS) {
    await new Promise<void>((resolve) => { backgroundSlotWaiters.push(resolve); });
  }
  backgroundSlotsInUse += 1;
}

function releaseBackgroundSlot(): void {
  backgroundSlotsInUse -= 1;
  backgroundSlotWaiters.shift()?.();
}

function backgroundFileStat(path: string): Promise<FileStatResult | undefined> {
  const existing = fileTasks.get(path);
  if (existing !== undefined) return existing;
  if (isHung(path)) return Promise.resolve(undefined);
  return registerFileTask(path, (async () => {
    await acquireBackgroundSlot();
    try {
      if (isHung(path) || outstandingBackgroundFsCalls + 1 > BACKGROUND_FS_CALL_LIMIT || outstandingFsCalls + 1 > MAX_OUTSTANDING_FS_CALLS) return undefined;
      return await withTimeout(path, backgroundStatProbe(path));
    } finally {
      releaseBackgroundSlot();
    }
  })());
}

function interactiveFileStat(path: string): Promise<FileStatResult | undefined> {
  const key = identityKey(path);
  const existing = fileTasks.get(key);
  if (existing !== undefined) return existing;
  if (isHung(path) || outstandingFsCalls + IDENTITY_PROBE_CALLS > MAX_OUTSTANDING_FS_CALLS) return Promise.resolve(undefined);
  return registerFileTask(key, withTimeout(key, identityProbe(path)));
}

function isExecutableTarget(path: string, probe: FileProbe, platform: NodeJS.Platform): boolean {
  return isExecutableDownload(path, probe.stats, platform) || (probe.real !== undefined && isExecutableDownload(probe.real, probe.stats, platform));
}

function sameFile(before: FileProbe, after: FileStatResult | undefined): after is FileProbe {
  if (after === undefined || !('stats' in after)) return false;
  const { stats, link, real } = after;
  return stats.isFile() && stats.dev === before.stats.dev && stats.ino === before.stats.ino
    && stats.size === before.stats.size && stats.mtimeMs === before.stats.mtimeMs && stats.ctimeMs === before.stats.ctimeMs
    && link !== undefined && before.link !== undefined && link.dev === before.link.dev && link.ino === before.link.ino
    && link.isSymbolicLink() === before.link.isSymbolicLink() && real !== undefined && real === before.real;
}

function fileExists(result: FileStatResult | undefined): boolean | undefined {
  if (result === undefined) return undefined;
  if ('stats' in result) return result.stats.isFile();
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' ? false : undefined;
}
let downloadsTimer: ReturnType<typeof setTimeout> | undefined;

function emitDownloadsChanged(): void {
  clearTimeout(downloadsTimer);
  downloadsTimer = undefined;
  for (const listener of downloadListeners) {
    try { listener(); } catch (error) { log.error('[kimi-desktop] browser downloads listener failed', error); }
  }
}

function scheduleDownloadsChanged(): void {
  if (downloadsTimer !== undefined) return;
  downloadsTimer = setTimeout(emitDownloadsChanged, DOWNLOAD_PROGRESS_INTERVAL_MS);
  downloadsTimer.unref?.();
}

export function onBrowserDownloadsChanged(listener: () => void): () => void {
  downloadListeners.add(listener);
  return () => { downloadListeners.delete(listener); };
}

function ensureRecordsLoaded(): void {
  if (recordsLoaded) return;
  recordsLoaded = true;
  const records = getBrowserRecords();
  history = records.history;
  const now = Date.now();
  downloads = records.downloads.map(entry => entry.state === 'progressing'
    ? { ...entry, state: 'interrupted', endedAt: now }
    : entry);
  if (records.downloads.some(entry => entry.state === 'progressing')) persistRecords();
}

function persistRecords(): void {
  clearTimeout(recordsTimer);
  recordsTimer = undefined;
  saveBrowserRecords({ history, downloads });
}

function scheduleRecords(): void {
  if (recordsTimer !== undefined) return;
  recordsTimer = setTimeout(() => {
    recordsTimer = undefined;
    try { persistRecords(); } catch (error) { log.error('[kimi-desktop] failed to save browser records', error); }
  }, 250);
  recordsTimer.unref?.();
}

export function flushBrowserRecords(): void {
  if (recordsTimer !== undefined) persistRecords();
}

function preferences(): BrowserPreferences {
  return getBrowserPreferences();
}

let downloadsDirectory: () => string = () => join(homedir(), 'Downloads');

export function configureBrowserDownloadsDirectory(resolve: () => string): void {
  downloadsDirectory = resolve;
}

export function browserAgentDownloadLocation(): BrowserAgentDownloadLocation {
  return resolveAgentDownloadLocation({ custom: preferences().agentDownloadDirectory, access: getBrowserDownloadsAccess(), downloads: downloadsDirectory() });
}

export function ensureBrowserDownloadsAccess(): BrowserAgentDownloadLocation {
  const location = browserAgentDownloadLocation();
  if (location.custom || location.access !== 'unknown') return location;
  saveBrowserDownloadsAccess(probeDownloadsAccessSync(downloadsDirectory()) === 'denied' ? 'denied' : 'granted');
  return browserAgentDownloadLocation();
}

export function noteBrowserDownloadsFailure(error: unknown): void {
  const location = browserAgentDownloadLocation();
  if (!location.custom && location.access === 'granted' && downloadsAccessFromError(error) === 'denied') saveBrowserDownloadsAccess('denied');
}

export async function checkBrowserDownloadsAccess(): Promise<BrowserDataSnapshot> {
  const access = await probeDownloadsAccess(downloadsDirectory());
  saveBrowserDownloadsAccess(access === 'denied' ? 'denied' : 'granted');
  return getBrowserData();
}

export function setBrowserAgentDownloadDirectory(directory: string): BrowserDataSnapshot {
  saveBrowserPreferences({ ...preferences(), agentDownloadDirectory: directory });
  return getBrowserData();
}

export function getBrowserData(): BrowserDataSnapshot {
  ensureRecordsLoaded();
  return {
    history: history.map((entry) => ({ ...entry })),
    preferences: preferences(),
    defaultUserAgent: defaultBrowserUserAgent(),
    agentDownloads: browserAgentDownloadLocation(),
  };
}

function publicDownload({ resume: _resume, ...entry }: BrowserDownloadRecord): BrowserDownloadEntry {
  return entry;
}

export function getBrowserDownloads(): BrowserDownloadEntry[] {
  ensureRecordsLoaded();
  return downloads.map(publicDownload);
}

export function updateBrowserPreferences(patch: BrowserPreferencesPatch): BrowserDataSnapshot {
  const current = preferences();
  const next: BrowserPreferences = {
    agentControl: typeof patch.agentControl === 'boolean' ? patch.agentControl : current.agentControl,
    subagentControl: typeof patch.subagentControl === 'boolean' ? patch.subagentControl : current.subagentControl,
    agentLocalFiles: typeof patch.agentLocalFiles === 'boolean' ? patch.agentLocalFiles : current.agentLocalFiles,
    searchEngine: isBrowserSearchEngine(patch.searchEngine) ? patch.searchEngine : current.searchEngine,
    autoplay: isBrowserAutoplay(patch.autoplay) ? patch.autoplay : current.autoplay,
    sound: isBrowserSound(patch.sound) ? patch.sound : current.sound,
    askWhereToSave:
      typeof patch.askWhereToSave === 'boolean' ? patch.askWhereToSave : current.askWhereToSave,
    defaultZoomFactor:
      typeof patch.defaultZoomFactor === 'number' &&
      Number.isFinite(patch.defaultZoomFactor) &&
      patch.defaultZoomFactor >= 0.5 &&
      patch.defaultZoomFactor <= 2
        ? patch.defaultZoomFactor
        : current.defaultZoomFactor,
    customUserAgent:
      patch.customUserAgent === null || isBrowserCustomUserAgent(patch.customUserAgent)
        ? patch.customUserAgent
        : current.customUserAgent,
    userAgentPresets: isBrowserUserAgentSavedPresets(patch.userAgentPresets)
      ? patch.userAgentPresets.map(preset => ({ name: preset.name, value: preset.value }))
      : current.userAgentPresets,
    ...(current.agentDownloadDirectory === undefined || patch.agentDownloadDirectory === null ? {} : { agentDownloadDirectory: current.agentDownloadDirectory }),
    ...('agentDownloadLimitBytes' in patch ? { agentDownloadLimitBytes: patch.agentDownloadLimitBytes } : current.agentDownloadLimitBytes === undefined ? {} : { agentDownloadLimitBytes: current.agentDownloadLimitBytes }),
  };
  saveBrowserPreferences(next);
  resetCustomBrowserUserAgentCache();
  return getBrowserData();
}

export function recordBrowserHistory(entry: Omit<BrowserHistoryEntry, 'id' | 'visitedAt'>): void {
  ensureRecordsLoaded();
  const now = Date.now();
  const normalized = asBrowserHistoryEntry({
    id: `history-${now}-${historySequence + 1}`,
    url: entry.url,
    title: entry.title.slice(0, BROWSER_RECORD_TITLE_MAX),
    favicon: persistableBrowserFavicon(entry.favicon) ?? history.find((previous) => previous.url === entry.url)?.favicon,
    visitedAt: now,
  });
  if (normalized === null) return;
  const latest = history[0];
  if (latest?.url === normalized.url && now - latest.visitedAt < 5_000) {
    history = [{ ...normalized, id: latest.id }, ...history.slice(1)];
    scheduleRecords();
    return;
  }
  historySequence += 1;
  history = [
    normalized,
    ...history,
  ].slice(0, MAX_HISTORY);
  scheduleRecords();
}

export function updateBrowserHistoryFavicon(url: string, value: string | undefined): void {
  ensureRecordsLoaded();
  const favicon = persistableBrowserFavicon(value);
  if (favicon === undefined) return;
  let changed = false;
  history = history.map((entry) => {
    if (entry.url !== url || entry.favicon === favicon) return entry;
    changed = true;
    return { ...entry, favicon };
  });
  if (changed) scheduleRecords();
}

function trimDownloads(list: BrowserDownloadRecord[]): BrowserDownloadRecord[] {
  const next = [...list];
  while (next.length > MAX_DOWNLOADS) {
    let index = next.length - 1;
    for (let candidate = next.length - 1; candidate >= 0; candidate -= 1) {
      if (!activeDownloads.has(next[candidate]!.id)) {
        index = candidate;
        break;
      }
    }
    next.splice(index, 1);
  }
  return next;
}

function resumeMetadata(item: DownloadItem): BrowserDownloadResume | undefined {
  const urlChain = item.getURLChain();
  if (urlChain.length === 0 || urlChain.length > BROWSER_DOWNLOAD_URL_CHAIN_MAX || urlChain.some((url) => url.length > BROWSER_RECORD_URL_MAX)) return undefined;
  const optional = (key: 'mimeType' | 'eTag' | 'lastModified', value: string, max: number) => (value === '' || value.length > max ? {} : { [key]: value });
  return {
    urlChain,
    ...optional('mimeType', item.getMimeType(), 256),
    ...optional('eTag', item.getETag(), 1_024),
    ...optional('lastModified', item.getLastModifiedTime(), 256),
  };
}

export function trackBrowserDownload(item: DownloadItem, retryOf?: string): string {
  ensureRecordsLoaded();
  const now = Date.now();
  const retried = retryOf === undefined ? undefined : downloads.find((entry) => entry.id === retryOf && !activeDownloads.has(entry.id));
  downloadSequence += 1;
  const id = retried?.id ?? `download-${now}-${downloadSequence}`;
  const snapshot = (state: BrowserDownloadEntry['state'], endedAt?: number): BrowserDownloadRecord => {
    const resume = state === 'progressing' || state === 'interrupted' ? resumeMetadata(item) : undefined;
    return asBrowserDownloadEntry({
      id,
      url: item.getURL().slice(0, BROWSER_RECORD_URL_MAX),
      urlTruncated: item.getURL().length > BROWSER_RECORD_URL_MAX,
      filename: item.getFilename().slice(0, BROWSER_RECORD_FILENAME_MAX),
      ...(item.getSavePath() === ''
        ? {}
        : { savePath: item.getSavePath().slice(0, BROWSER_RECORD_PATH_MAX) }),
      pathTruncated: item.getSavePath().length > BROWSER_RECORD_PATH_MAX,
      state,
      startedAt: retried?.startedAt ?? (Math.round(item.getStartTime() * 1_000) || now),
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      ...(endedAt === undefined ? {} : { endedAt }),
      ...(resume === undefined ? {} : { resume }),
    }) ?? {
      id,
      url: '',
      filename: '',
      state,
      startedAt: now,
      receivedBytes: 0,
      totalBytes: 0,
    };
  };
  const replace = (entry: BrowserDownloadRecord, final = false): void => {
    const index = downloads.findIndex((candidate) => candidate.id === id);
    if (index === -1) return;
    downloads = downloads.map((candidate) => (candidate.id === id ? entry : candidate));
    if (final) {
      persistRecords();
      emitDownloadsChanged();
    } else {
      scheduleRecords();
      scheduleDownloadsChanged();
    }
  };
  activeDownloads.set(id, item);
  downloadFileMissing.delete(id);
  downloads = retried === undefined
    ? trimDownloads([snapshot('progressing'), ...downloads])
    : downloads.map((entry) => (entry.id === id ? snapshot('progressing') : entry));
  for (const known of downloadFileMissing.keys()) {
    if (!downloads.some((entry) => entry.id === known)) downloadFileMissing.delete(known);
  }
  persistRecords();
  emitDownloadsChanged();
  item.on('updated', (_event, state) => {
    replace(snapshot(state === 'interrupted' ? 'interrupted' : 'progressing'));
  });
  item.once('done', (_event, state) => {
    activeDownloads.delete(id);
    const normalized =
      state === 'completed' || state === 'cancelled' ? state : 'interrupted';
    replace(snapshot(normalized, Date.now()), true);
    if (normalized !== 'completed') return;
    void refreshBrowserDownloadFiles([id]);
  });
  return id;
}

export function relocateBrowserDownload(id: string, savePath: string): boolean {
  ensureRecordsLoaded();
  const entry = downloads.find((candidate) => candidate.id === id);
  if (entry === undefined || activeDownloads.has(id)) return false;
  downloads = downloads.map((candidate) => (candidate.id === id ? { ...candidate, savePath: savePath.slice(0, BROWSER_RECORD_PATH_MAX), pathTruncated: savePath.length > BROWSER_RECORD_PATH_MAX } : candidate));
  downloadFileMissing.delete(id);
  persistRecords();
  emitDownloadsChanged();
  return true;
}

export function clearBrowserHistory(): BrowserDataSnapshot {
  ensureRecordsLoaded();
  history = [];
  persistRecords();
  return getBrowserData();
}

export function clearBrowserDownloads(): BrowserDataSnapshot {
  ensureRecordsLoaded();
  downloads = downloads.filter((entry) => activeDownloads.has(entry.id));
  downloadFileMissing.clear();
  persistRecords();
  emitDownloadsChanged();
  return getBrowserData();
}

export function removeBrowserDownload(id: string): boolean {
  ensureRecordsLoaded();
  const entry = downloads.find((candidate) => candidate.id === id);
  if (entry === undefined || entry.state === 'progressing' || activeDownloads.has(id)) return false;
  downloads = downloads.filter((candidate) => candidate !== entry);
  downloadFileMissing.delete(id);
  persistRecords();
  emitDownloadsChanged();
  return true;
}

function liveDownloadState(entry: BrowserDownloadRecord): Partial<BrowserDownloadItem> {
  const item = activeDownloads.get(entry.id);
  if (item === undefined) return {};
  if (entry.state === 'progressing' ? item.isPaused() : item.canResume()) return { active: true, resumable: true };
  const speed = entry.state === 'progressing' ? item.getCurrentBytesPerSecond() : 0;
  return Number.isFinite(speed) && speed > 0 ? { active: true, speed: Math.round(speed) } : { active: true };
}

export function getBrowserDownloadItems(): BrowserDownloadItem[] {
  ensureRecordsLoaded();
  return downloads.map((entry) => {
    const missing = entry.state === 'completed' && entry.pathTruncated !== true ? downloadFileMissing.get(entry.id) : undefined;
    return {
      ...publicDownload(entry),
      ...(missing === undefined ? {} : { fileMissing: missing }),
      ...liveDownloadState(entry),
    };
  });
}

export function controlBrowserDownload(request: BrowserDownloadControl): boolean {
  ensureRecordsLoaded();
  const item = activeDownloads.get(request.id);
  if (item === undefined) return false;
  if (request.action === 'pause') {
    if (item.getState() !== 'progressing' || item.isPaused()) return false;
    item.pause();
  } else if (request.action === 'resume') {
    if (!item.canResume()) return false;
    item.resume();
  } else {
    item.cancel();
  }
  emitDownloadsChanged();
  return true;
}

const DOWNLOAD_RETRY_CLAIM_MS = 60_000;
type PendingRetry = { id: string; urls: Set<string>; savePath?: string; resume: boolean; expires: number };
let pendingRetries: PendingRetry[] = [];

export interface BrowserDownloadRetry {
  id: string;
  savePath?: string;
  resume: boolean;
}

export interface BrowserDownloadRetryDeps {
  session: Pick<Session, 'createInterruptedDownload' | 'downloadURL'>;
  isAllowedUrl: (url: string) => boolean;
}

async function interruptedDownloadOptions(entry: BrowserDownloadRecord, path: string | undefined, isAllowedUrl: (url: string) => boolean): Promise<Parameters<Session['createInterruptedDownload']>[0] | undefined> {
  const { resume } = entry;
  if (path === undefined || resume === undefined || (resume.eTag === undefined && resume.lastModified === undefined)) return undefined;
  if (!resume.urlChain.every(isAllowedUrl)) return undefined;
  if (entry.receivedBytes <= 0 || entry.totalBytes <= 0 || entry.receivedBytes >= entry.totalBytes) return undefined;
  const probe = await interactiveFileStat(path);
  if (probe === undefined || !('stats' in probe) || !probe.stats.isFile() || probe.stats.size < entry.receivedBytes) return undefined;
  return {
    path,
    urlChain: resume.urlChain,
    ...(resume.mimeType === undefined ? {} : { mimeType: resume.mimeType }),
    offset: entry.receivedBytes,
    length: entry.totalBytes,
    ...(resume.lastModified === undefined ? {} : { lastModified: resume.lastModified }),
    ...(resume.eTag === undefined ? {} : { eTag: resume.eTag }),
    startTime: entry.startedAt / 1_000,
  };
}

export async function retryBrowserDownload(id: string, deps: BrowserDownloadRetryDeps): Promise<boolean> {
  ensureRecordsLoaded();
  const live = activeDownloads.get(id);
  if (live !== undefined) {
    if (live.getState() !== 'interrupted' || !live.canResume()) return false;
    live.resume();
    emitDownloadsChanged();
    return true;
  }
  const entry = downloads.find((candidate) => candidate.id === id);
  if (entry?.state !== 'interrupted' || entry.urlTruncated === true || !deps.isAllowedUrl(entry.url)) return false;
  const urls = new Set([entry.url, ...(entry.resume?.urlChain ?? [])]);
  const hasPendingRetry = (): boolean => pendingRetries.some((pending) => pending.expires > Date.now() && (pending.id === id || [...urls].some((url) => pending.urls.has(url))));
  if (hasPendingRetry()) return false;
  const savePath = entry.savePath === undefined || entry.pathTruncated === true ? undefined : entry.savePath;
  const options = await interruptedDownloadOptions(entry, savePath, deps.isAllowedUrl);
  const current = downloads.find((candidate) => candidate.id === id);
  if (current !== entry || activeDownloads.has(id) || hasPendingRetry()) return false;
  pendingRetries = pendingRetries.filter((pending) => pending.expires > Date.now());
  pendingRetries.push({ id, savePath, resume: options !== undefined, expires: Date.now() + DOWNLOAD_RETRY_CLAIM_MS, urls });
  if (options === undefined) deps.session.downloadURL(entry.url);
  else deps.session.createInterruptedDownload(options);
  return true;
}

export function claimBrowserDownloadRetry(item: DownloadItem, fromPage: boolean): BrowserDownloadRetry | undefined {
  const now = Date.now();
  pendingRetries = pendingRetries.filter((pending) => pending.expires > now);
  if (fromPage) return undefined;
  const urls = [item.getURL(), ...item.getURLChain()];
  const path = item.getSavePath();
  const recreated = item.getState() === 'interrupted';
  const index = pendingRetries.findIndex((pending) => pending.resume === recreated
    && (!recreated || (path !== '' && pending.savePath === path))
    && urls.some((url) => pending.urls.has(url)));
  if (index === -1) return undefined;
  const [pending] = pendingRetries.splice(index, 1);
  return { id: pending!.id, resume: pending!.resume, ...(pending!.savePath === undefined ? {} : { savePath: pending!.savePath }) };
}

export async function refreshBrowserDownloadFiles(ids?: readonly string[]): Promise<boolean> {
  ensureRecordsLoaded();
  const targets = downloads.filter((entry) =>
    entry.state === 'completed' && entry.savePath !== undefined && entry.pathTruncated !== true && (ids === undefined || ids.includes(entry.id)));
  let changed = false;
  await Promise.all(targets.map(async (entry) => {
    const exists = fileExists(await backgroundFileStat(entry.savePath!));
    if (exists === undefined || !downloads.includes(entry) || downloadFileMissing.get(entry.id) === !exists) return;
    downloadFileMissing.set(entry.id, !exists);
    changed = true;
    scheduleDownloadsChanged();
  }));
  if (changed) emitDownloadsChanged();
  return changed;
}

export function readBrowserDownloads(): BrowserDownloadItem[] {
  void refreshBrowserDownloadFiles();
  return getBrowserDownloadItems();
}

export const EXECUTABLE_DOWNLOAD_EXTENSIONS = {
  all: [
    '.app', '.pkg', '.mpkg', '.sh', '.command', '.tool', '.bash', '.zsh', '.csh', '.ksh', '.py', '.pyw', '.pyc', '.pyo', '.pyz', '.pyzw', '.pl', '.rb', '.js', '.jar',
    '.scpt', '.applescript', '.workflow', '.terminal',
    '.deb', '.rpm', '.flatpak', '.flatpakref', '.flatpakrepo', '.snap', '.appimage', '.run', '.desktop', '.apk', '.xbps',
    '.pkg.tar.zst', '.pkg.tar.xz',
    '.prefpane', '.saver', '.qlgenerator', '.kext', '.osax', '.scptd', '.mobileconfig', '.fileloc', '.inetloc', '.jnlp',
  ],
  windows: [
    '.exe', '.msi', '.bat', '.cmd', '.com', '.ps1', '.vbs', '.wsf', '.scr', '.lnk', '.reg', '.hta', '.cpl',
    '.msix', '.msixbundle', '.appx', '.appxbundle', '.appinstaller', '.application', '.appref-ms',
    '.msp', '.mst', '.pif', '.gadget', '.vbe', '.jse', '.wsh', '.psc1', '.ws', '.settingcontent-ms',
    '.diagcab', '.library-ms', '.url', '.website', '.xbap',
    '.chm', '.hlp', '.inf', '.ins', '.isp', '.job', '.msc', '.msh', '.msh1', '.msh2', '.mshxml', '.msh1xml', '.msh2xml',
    '.ps1xml', '.ps2', '.ps2xml', '.psc2', '.scf', '.sct', '.shb', '.shs', '.vb', '.vxd', '.wsc', '.xll',
    '.ade', '.adp', '.mda', '.mde', '.accde', '.search-ms', '.searchconnector-ms', '.theme', '.themepack',
    '.appcontent-ms', '.bas', '.bgi', '.cdxml', '.cnt', '.fxp', '.grp', '.hpj', '.htc', '.its', '.mad', '.maf', '.mag',
    '.mam', '.maq', '.mar', '.mas', '.mat', '.mau', '.mav', '.maw', '.mcf', '.mdb', '.mdt', '.mdw', '.mdz', '.msu',
    '.ops', '.osd', '.pcd', '.plg', '.prf', '.prg', '.printerexport', '.psd1', '.psdm1', '.psm1', '.pssc', '.udl',
    '.vbp', '.vbscript', '.vsmacros', '.vsw', '.webpnp', '.wsb', '.xnk', '.ahk', '.au3', '.a3x', '.rdp',
  ],
} as const;

export function isExecutableDownload(
  path: string,
  file: Pick<Stats, 'mode'> & { isFile(): boolean; isDirectory(): boolean },
  platform: NodeJS.Platform,
): boolean {
  const name = basename(path).toLowerCase();
  const matches = (extensions: readonly string[]): boolean => extensions.some((extension) => name.endsWith(extension));
  if (matches(EXECUTABLE_DOWNLOAD_EXTENSIONS.all)) return true;
  if (platform === 'win32') return matches(EXECUTABLE_DOWNLOAD_EXTENSIONS.windows);
  if (file.isDirectory()) return true;
  return file.isFile() && (file.mode & 0o111) !== 0;
}

export interface BrowserDownloadDialogStrings {
  openDialog: { title: string; message: string; detail: string; open: string; cancel: string };
  blockedDialog: { title: string; message: string; detail: string; showInFolder: string; ok: string };
  openFailedDialog: { title: string; message: string; detail: string; unavailable: string; changed: string; ok: string };
}

const OPEN_ERROR_DETAIL_MAX = 300;

function readableOpenError(error: string): string | null {
  const reason = error.trim();
  return reason !== '' && reason.length <= OPEN_ERROR_DETAIL_MAX && !/[\r\n]/.test(reason) ? reason : null;
}

export interface BrowserDownloadOpenDeps {
  shell: Pick<Shell, 'openPath' | 'showItemInFolder'>;
  showMessageBox: (options: MessageBoxOptions) => Promise<number>;
  strings: () => BrowserDownloadDialogStrings;
  platform?: NodeJS.Platform;
}

export async function openBrowserDownload(
  request: BrowserDownloadAction & { action: 'open' | 'show' },
  deps: BrowserDownloadOpenDeps,
): Promise<boolean> {
  ensureRecordsLoaded();
  const entry = downloads.find((candidate) => candidate.id === request.id);
  if (entry?.state !== 'completed' || entry.savePath === undefined || entry.pathTruncated === true) return false;
  const path = entry.savePath;
  const name = basename(path);
  const result = await interactiveFileStat(path);
  const exists = fileExists(result);
  if (exists === false) {
    if (downloads.includes(entry)) downloadFileMissing.set(entry.id, true);
    return false;
  }
  const showFailure = async (detail: keyof Omit<BrowserDownloadDialogStrings['openFailedDialog'], 'title' | 'message' | 'ok'>): Promise<true> => {
    const failed = deps.strings().openFailedDialog;
    await deps.showMessageBox({
      type: 'error', title: failed.title, message: failed.message.replace('{name}', () => name),
      detail: failed[detail], buttons: [failed.ok], defaultId: 0, cancelId: 0, noLink: true,
    });
    return true;
  };
  if (result === undefined || !('stats' in result)) return showFailure(result === undefined ? 'unavailable' : 'detail');
  if (request.action === 'show') {
    deps.shell.showItemInFolder(path);
    return true;
  }
  const strings = deps.strings();
  if (isExecutableTarget(path, result, deps.platform ?? process.platform)) {
    const blocked = strings.blockedDialog;
    const choice = await deps.showMessageBox({
      type: 'warning', title: blocked.title, message: blocked.message.replace('{name}', () => name), detail: blocked.detail,
      buttons: [blocked.showInFolder, blocked.ok], defaultId: 1, cancelId: 1, noLink: true,
    });
    if (choice === 0) deps.shell.showItemInFolder(path);
    return true;
  }
  const confirm = strings.openDialog;
  const choice = await deps.showMessageBox({
    type: 'question', title: confirm.title, message: confirm.message.replace('{name}', () => name), detail: confirm.detail,
    buttons: [confirm.open, confirm.cancel], defaultId: 0, cancelId: 1, noLink: true,
  });
  if (choice !== 0) return true;
  const confirmed = await interactiveFileStat(path);
  if (confirmed === undefined) return showFailure('unavailable');
  if (!sameFile(result, confirmed) || isExecutableTarget(path, confirmed, deps.platform ?? process.platform)) {
    return showFailure('changed');
  }
  const error = await deps.shell.openPath(path);
  if (error === '') return true;
  log.warn(`[kimi-desktop] could not open download: ${error}`);
  const failed = strings.openFailedDialog;
  await deps.showMessageBox({
    type: 'error', title: failed.title, message: failed.message.replace('{name}', () => name),
    detail: readableOpenError(error) ?? failed.detail, buttons: [failed.ok], defaultId: 0, cancelId: 0, noLink: true,
  });
  return true;
}

export function getBrowserFileCheckStateForTest(): { tasks: number; queued: number; outstanding: number; hung: number } {
  return { tasks: fileTasks.size, queued: backgroundSlotWaiters.length, outstanding: outstandingFsCalls, hung: hungFileKeys.size };
}

export function resetBrowserDataForTest(): void {
  clearTimeout(recordsTimer);
  recordsTimer = undefined;
  clearTimeout(downloadsTimer);
  downloadsTimer = undefined;
  downloadListeners.clear();
  downloadFileMissing.clear();
  activeDownloads.clear();
  pendingRetries = [];
  fileTasks.clear();
  hungFileKeys.clear();
  outstandingFsCalls = 0;
  outstandingBackgroundFsCalls = 0;
  fsCallGeneration += 1;
  backgroundSlotsInUse = 0;
  backgroundSlotWaiters.length = 0;
  history = [];
  downloads = [];
  historySequence = 0;
  downloadSequence = 0;
  recordsLoaded = true;
}
