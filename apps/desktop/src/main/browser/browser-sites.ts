import { app, session } from 'electron';
import { randomUUID } from 'node:crypto';
import type { Cookie, Session, WebContents } from 'electron';
import type { MainWindow } from '../window/main-window';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asBrowserSiteRecord, browserSiteOrigin, type BrowserSiteInfo, type BrowserSitePermission, type BrowserSitePermissionSetting, type BrowserSiteRecord, type BrowserPermissionRequest, type BrowserPermissionDecision } from '../../shared/browser-sites';
import { getBrowserData } from './browser-data';
import { pushAgentBrowserNotice } from './browser-dialogs';
import { log } from '../diagnostics/log';
import { resolveBrowserAutoplayPolicy, type BrowserAutoplayPolicy, type BrowserSiteAutoplay } from '../../shared/browser-autoplay';
import { resolveBrowserSoundMuted, type BrowserSiteSound } from '../../shared/browser-sound';

export const BROWSER_PARTITION = 'persist:kimi-browser';
let records: Map<string, BrowserSiteRecord> | null = null;
const pending = new Map<string, { request: BrowserPermissionRequest; key: string; settled: Promise<void>; finish: (decision?: BrowserPermissionDecision['decision']) => void; callbacks: Array<(allowed: boolean) => void> }>();
const protectedContents = new WeakSet<WebContents>();
let permissionHost: () => MainWindow | null = () => null;
const answerListeners = new Set<(browserId: string) => void>();

export function onBrowserPermissionUserAnswer(listener: (browserId: string) => void): () => void {
  answerListeners.add(listener);
  return () => answerListeners.delete(listener);
}

function notifyUserAnswer(browserId: string): void {
  for (const listener of Array.from(answerListeners)) listener(browserId);
}

export function getBrowserPermissionRequests(): BrowserPermissionRequest[] {
  return [...pending.values()].map(entry => ({ ...entry.request, permissions: [...entry.request.permissions] }));
}

export async function waitForBrowserPermissionRequests(browserId: string, signal?: AbortSignal): Promise<void> {
  while (true) {
    if (signal?.aborted) throw new Error('Browser permission wait aborted');
    const requests = [...pending.values()].filter(entry => entry.request.browserId === browserId);
    if (requests.length === 0) return;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        Promise.all(requests.map(entry => entry.settled)),
        new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('Browser permission wait aborted')); signal?.addEventListener('abort', abort, { once: true }); }),
      ]);
    } finally { if (abort) signal?.removeEventListener('abort', abort); }
  }
}

function publishPermissionRequests(): void {
  const host = permissionHost();
  if (host && !host.isDestroyed() && !host.webContents.isDestroyed()) host.webContents.send('kimi:browser-permission-requests', getBrowserPermissionRequests());
}

export function resolveBrowserPermissionRequest(answer: BrowserPermissionDecision): boolean {
  const entry = pending.get(answer.requestId);
  if (!entry) return false;
  notifyUserAnswer(entry.request.browserId);
  entry.finish(answer.decision);
  return true;
}

function storedSites(): Map<string, BrowserSiteRecord> {
  if (records !== null) return records;
  records = new Map();
  try {
    const raw: unknown = JSON.parse(readFileSync(join(app.getPath('userData'), 'browser-sites.json'), 'utf8'));
    if (Array.isArray(raw)) for (const value of raw.slice(0, 2000)) {
      const site = asBrowserSiteRecord(value);
      if (site !== null) records.set(site.origin, site);
    }
  } catch { return records; }
  return records;
}

function saveSites(next: Map<string, BrowserSiteRecord>): void {
  if (next.size > 2000) throw new Error('Too many site settings');
  const directory = app.getPath('userData');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'browser-sites.json');
  writeFileSync(`${file}.tmp`, JSON.stringify([...next.values()]), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  records = next;
}

function siteRecord(origin: string): BrowserSiteRecord {
  return storedSites().get(origin) ?? { origin, lastVisitedAt: 0, permissions: {} };
}

export function recordBrowserSiteVisit(url: string): void {
  const origin = browserSiteOrigin(url);
  if (origin === null || (!storedSites().has(origin) && storedSites().size >= 2000)) return;
  const next = new Map(storedSites());
  next.set(origin, { ...siteRecord(origin), lastVisitedAt: Date.now() });
  try { saveSites(next); } catch (error) { log.warn(`[kimi-desktop] site history could not be saved: ${String(error)}`); }
}

export function forgetBrowserSiteVisits(): void {
  const next = new Map<string, BrowserSiteRecord>();
  for (const site of storedSites().values()) {
    if (Object.keys(site.permissions).length > 0 || (site.autoplay !== undefined && site.autoplay !== 'default') || (site.sound !== undefined && site.sound !== 'default')) next.set(site.origin, { ...site, lastVisitedAt: 0 });
  }
  saveSites(next);
}

function setPermission(origin: string, permissions: BrowserSitePermission[], setting: BrowserSitePermissionSetting): void {
  const previous = siteRecord(origin);
  const next = new Map(storedSites());
  next.set(origin, { ...previous, permissions: { ...previous.permissions, ...Object.fromEntries(permissions.map((permission) => [permission, setting])) } });
  saveSites(next);
  const waiting = [...pending.values()];
  for (const entry of waiting) {
    if (entry.request.origin !== origin) continue;
    const policy = siteRecord(origin).permissions;
    const decision = entry.request.permissions.some(key => policy[key] === 'block') ? 'block' : entry.request.permissions.every(key => policy[key] === 'allow') ? 'allow-once' : undefined;
    if (decision === undefined || !pending.has(entry.request.requestId)) continue;
    notifyUserAnswer(entry.request.browserId);
    entry.finish(decision === 'block' ? undefined : decision);
  }
}

function requestedPermissions(permission: string, media: readonly string[] = []): BrowserSitePermission[] {
  if (permission === 'media') return media.every(kind => kind === 'audio' || kind === 'video') ? media.map((kind) => kind === 'audio' ? 'microphone' : 'camera') : [];
  const mapping: Record<string, BrowserSitePermission> = { geolocation: 'location', notifications: 'notifications', 'clipboard-read': 'clipboard', 'clipboard-sanitized-write': 'clipboardWrite', 'deprecated-sync-clipboard-read': 'clipboard', fullscreen: 'fullscreen', midi: 'midi', midiSysex: 'midiSysex' };
  const mapped = mapping[permission];
  return mapped === undefined ? [] : [mapped];
}

function noteDeniedPermission(browserId: string | undefined, permission: string, externalURL: string | undefined, origin: string): void {
  if (permission === 'media' || permission === 'display-capture') {
    pushAgentBrowserNotice(browserId, 'The page asked to capture the screen or a window. Screen sharing is not supported in the built-in browser, so the request was denied.', { kind: 'screen-capture', origin });
  } else if (permission === 'openExternal') {
    const url = externalURL ?? '';
    let scheme = 'External';
    try { scheme = new URL(url).protocol; } catch { scheme = 'External'; }
    pushAgentBrowserNotice(browserId, `The page tried to open ${url.length > 200 ? `${url.slice(0, 199)}…` : url || 'an external app'}. ${scheme} links are blocked in the built-in browser; ask the user to open it in another app if needed.`, { kind: 'external-app', origin, message: url.length > 200 ? `${url.slice(0, 199)}…` : url });
  }
}

export function configureBrowserSitePermissions(browserSession: Session, host: () => MainWindow | null, browserIdFor: (contents: WebContents) => string | undefined = () => undefined): void {
  permissionHost = host;
  browserSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const origin = browserSiteOrigin(details.securityOrigin ?? requestingOrigin);
    const requested = requestedPermissions(permission, details.mediaType === 'audio' || details.mediaType === 'video' ? [details.mediaType] : []);
    return origin !== null && requested.length > 0 && requested.every((key) => siteRecord(origin).permissions[key] === 'allow');
  });
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = browserSiteOrigin('securityOrigin' in details ? details.securityOrigin ?? details.requestingUrl : details.requestingUrl);
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    const requested = requestedPermissions(permission, mediaTypes ?? []);
    if (requested.length === 0 && !contents.isDestroyed() && (permission !== 'media' || mediaTypes?.length === 0)) noteDeniedPermission(browserIdFor(contents), permission, 'externalURL' in details ? details.externalURL : undefined, origin ?? '');
    if (origin === null || requested.length === 0 || contents.isDestroyed()) { callback(false); return; }
    const policy = siteRecord(origin).permissions;
    if (requested.some((key) => policy[key] === 'block')) { callback(false); return; }
    if (requested.every((key) => policy[key] === 'allow')) { callback(true); return; }
    const browserId = browserIdFor(contents);
    if (!browserId) { callback(false); return; }
    if (!protectedContents.has(contents)) {
      const block = (event: { preventDefault: () => void }) => { if ([...pending.values()].some(entry => entry.request.browserId === browserId)) event.preventDefault(); };
      contents.on('before-input-event', block);
      contents.on('before-mouse-event', block);
      protectedContents.add(contents);
    }
    const documentOrigin = browserSiteOrigin(contents.getURL());
    const key = `${contents.id}:${details.isMainFrame}:${origin}:${requested.join(',')}`;
    const existing = [...pending.values()].find(entry => entry.key === key);
    if (existing) { if (existing.callbacks.length < 64) existing.callbacks.push(callback); else callback(false); return; }
    if (pending.size >= 64) { callback(false); return; }
    const requestId = `permission-${randomUUID()}`;
    const callbacks = [callback];
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const cancel = () => finish();
    const navigate = (event: { isSameDocument?: boolean; isMainFrame?: boolean }) => { if (!event.isSameDocument && (!details.isMainFrame || event.isMainFrame !== false)) finish(); };
    const finish = (decision?: BrowserPermissionDecision['decision']) => {
      if (!pending.delete(requestId)) return;
      contents.removeListener('destroyed', cancel);
      contents.removeListener('render-process-gone', cancel);
      contents.removeListener('did-start-navigation', navigate);
      let allowed = false;
      if (!contents.isDestroyed() && browserSiteOrigin(contents.getURL()) === documentOrigin && decision !== undefined) {
        try {
          if (decision !== 'allow-once') setPermission(origin, requested, decision === 'allow-always' ? 'allow' : 'block');
          allowed = decision !== 'block';
        } catch (error) { log.warn(`[kimi-desktop] permission decision could not be saved: ${String(error)}`); }
      }
      publishPermissionRequests();
      settle();
      for (const cb of callbacks) cb(allowed);
    };
    pending.set(requestId, { key, settled, callbacks, finish, request: { requestId, browserId, origin, permissions: requested } });
    contents.once('destroyed', cancel);
    contents.once('render-process-gone', cancel);
    contents.on('did-start-navigation', navigate);
    publishPermissionRequests();
  });
}

function siteCookies(origin: string, cookies: Cookie[]): Cookie[] {
  const hostname = new URL(origin).hostname;
  return cookies.filter((cookie) => {
    if (!cookie.domain) return false;
    const domain = cookie.domain.replace(/^\./, '');
    return hostname === domain || (cookie.hostOnly !== true && hostname.endsWith(`.${domain}`));
  });
}

export async function getBrowserSites(): Promise<BrowserSiteInfo[]> {
  const all = new Map(storedSites());
  for (const entry of getBrowserData().history) {
    const origin = browserSiteOrigin(entry.url);
    if (origin !== null && !all.has(origin)) all.set(origin, { origin, lastVisitedAt: entry.visitedAt, permissions: {} });
  }
  const cookies = await session.fromPartition(BROWSER_PARTITION).cookies.get({});
  for (const cookie of cookies) {
    if (!cookie.domain) continue;
    const origin = browserSiteOrigin(`https://${cookie.domain.replace(/^\./, '')}`);
    if (origin !== null && !all.has(origin)) all.set(origin, { origin, lastVisitedAt: 0, permissions: {} });
  }
  return [...all.values()].slice(0, 4000).map((site) => ({ ...site, permissions: { ...site.permissions }, cookieCount: siteCookies(site.origin, cookies).length }));
}

export async function getBrowserSite(url: string): Promise<BrowserSiteInfo> {
  const origin = browserSiteOrigin(url);
  if (origin === null) throw new Error('Invalid site');
  const cookies = await session.fromPartition(BROWSER_PARTITION).cookies.get({});
  const site = siteRecord(origin);
  return { ...site, permissions: { ...site.permissions }, cookieCount: siteCookies(origin, cookies).length };
}

export async function updateBrowserSitePermission(origin: string, permission: BrowserSitePermission, setting: BrowserSitePermissionSetting): Promise<BrowserSiteInfo> {
  const canonical = browserSiteOrigin(origin);
  if (canonical === null) throw new Error('Invalid site');
  setPermission(canonical, [permission], setting);
  return getBrowserSite(canonical);
}

export function browserAutoplayPolicy(url: string): BrowserAutoplayPolicy {
  const origin = browserSiteOrigin(url);
  const site = origin === null ? undefined : storedSites().get(origin);
  return resolveBrowserAutoplayPolicy(getBrowserData().preferences.autoplay, site?.autoplay);
}

export async function updateBrowserSiteAutoplay(origin: string, setting: BrowserSiteAutoplay): Promise<BrowserSiteInfo> {
  const canonical = browserSiteOrigin(origin);
  if (canonical === null) throw new Error('Invalid site');
  const previous = siteRecord(canonical);
  const next = new Map(storedSites());
  next.set(canonical, { ...previous, autoplay: setting });
  saveSites(next);
  return getBrowserSite(canonical);
}

export function browserSoundMuted(url: string): boolean {
  const origin = browserSiteOrigin(url);
  const site = origin === null ? undefined : storedSites().get(origin);
  return resolveBrowserSoundMuted(getBrowserData().preferences.sound, site?.sound);
}

export async function updateBrowserSiteSound(origin: string, setting: BrowserSiteSound): Promise<BrowserSiteInfo> {
  const canonical = browserSiteOrigin(origin);
  if (canonical === null) throw new Error('Invalid site');
  const previous = siteRecord(canonical);
  const next = new Map(storedSites());
  next.set(canonical, { ...previous, sound: setting });
  saveSites(next);
  return getBrowserSite(canonical);
}

export async function clearBrowserSiteStorage(origin: string): Promise<BrowserSiteInfo> {
  const canonical = browserSiteOrigin(origin);
  if (canonical === null) throw new Error('Invalid site');
  origin = canonical;
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  const cookies = siteCookies(origin, await browserSession.cookies.get({}));
  for (const cookie of cookies) {
    const url = new URL(origin);
    url.protocol = cookie.secure ? 'https:' : 'http:';
    url.port = '';
    url.pathname = cookie.path || '/';
    await browserSession.cookies.remove(url.toString(), cookie.name);
  }
  await browserSession.clearData({ origins: [origin], dataTypes: ['cache'], originMatchingMode: 'origin-in-all-contexts' });
  await browserSession.clearStorageData({ origin, storages: ['indexdb', 'localstorage', 'serviceworkers', 'cachestorage', 'filesystem'] });
  return getBrowserSite(origin);
}

export function resetBrowserSitesForTest(): void { const waiting = [...pending.values()]; for (const entry of waiting) entry.finish(); records = null; pending.clear(); permissionHost = () => null; }
