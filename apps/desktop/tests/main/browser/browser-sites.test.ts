import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from 'electron';

const mocks = vi.hoisted(() => ({ directory: '', autoplay: 'block' as 'allow' | 'block', prompt: vi.fn(), clearData: vi.fn(), clearStorageData: vi.fn(), removeCookie: vi.fn(), cookies: vi.fn(async () => [{ name: 'example', domain: '.example.test' }, { name: 'other', domain: 'other.test' }]) }));
vi.mock('electron', () => ({
  app: { getPath: () => mocks.directory },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showMessageBox: mocks.prompt },
  session: { fromPartition: () => ({ cookies: { get: mocks.cookies, remove: mocks.removeCookie }, clearData: mocks.clearData, clearStorageData: mocks.clearStorageData }) },
}));
vi.mock('../../../src/main/shell/context-menu', () => ({ effectiveContextMenuLocale: () => 'en' }));
vi.mock('../../../src/main/browser/browser-data', () => ({ getBrowserData: () => ({ history: [], preferences: { autoplay: mocks.autoplay } }) }));
vi.mock('../../../src/main/diagnostics/log', () => ({ log: { warn: vi.fn() } }));

import { configureBrowserDialogs, resetBrowserDialogsForTest, takeBrowserNotices } from '../../../src/main/browser/browser-dialogs';
import { browserAutoplayPolicy, onBrowserPermissionUserAnswer, forgetBrowserSiteVisits, getBrowserSites, recordBrowserSiteVisit, waitForBrowserPermissionRequests, getBrowserPermissionRequests, resolveBrowserPermissionRequest, clearBrowserSiteStorage as clearBrowserSiteData, configureBrowserSitePermissions, getBrowserSite, resetBrowserSitesForTest, updateBrowserSiteAutoplay, updateBrowserSitePermission } from '../../../src/main/browser/browser-sites';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.directory = mkdtempSync(join(tmpdir(), 'browser-sites-'));
  mocks.prompt.mockResolvedValue({ response: 0 });
  resetBrowserSitesForTest();
  mocks.autoplay = 'block';
});
afterEach(() => rmSync(mocks.directory, { recursive: true, force: true }));

describe('browser site controls', () => {
  it('persists permission choices by canonical origin', async () => {
    await updateBrowserSitePermission('https://example.test/path', 'camera', 'block');
    resetBrowserSitesForTest();
    expect(await getBrowserSite('https://example.test/other')).toMatchObject({ origin: 'https://example.test', permissions: { camera: 'block' }, cookieCount: 1 });
    expect((await getBrowserSite('https://other.test')).permissions).toEqual({});
  });

  it('persists autoplay overrides and resolves them ahead of the global default', async () => {
    expect(browserAutoplayPolicy('https://example.test/media')).toBe('document-user-activation-required');
    mocks.autoplay = 'allow';
    expect(browserAutoplayPolicy('https://example.test/media')).toBe('no-user-gesture-required');
    await updateBrowserSiteAutoplay('https://example.test/path', 'block');
    resetBrowserSitesForTest();
    expect(await getBrowserSite('https://example.test')).toMatchObject({ autoplay: 'block' });
    expect(browserAutoplayPolicy('https://example.test/media')).toBe('user-gesture-required');
    expect(browserAutoplayPolicy('https://other.test/media')).toBe('no-user-gesture-required');
    await updateBrowserSiteAutoplay('https://example.test', 'default');
    expect(browserAutoplayPolicy('https://example.test/media')).toBe('no-user-gesture-required');
    await expect(updateBrowserSiteAutoplay('file:///tmp/media.html', 'allow')).rejects.toThrow('Invalid site');
  });

  it('forgets visit-only sites and visit times when history is cleared', async () => {
    recordBrowserSiteVisit('https://visited.test/page');
    recordBrowserSiteVisit('https://example.test/page');
    await updateBrowserSitePermission('https://example.test', 'camera', 'allow');
    expect((await getBrowserSites()).map((site) => site.origin)).toContain('https://visited.test');
    forgetBrowserSiteVisits();
    resetBrowserSitesForTest();
    const sites = await getBrowserSites();
    expect(sites.map((site) => site.origin).sort()).toEqual(['https://example.test', 'https://other.test']);
    expect(sites.find((site) => site.origin === 'https://example.test')).toMatchObject({ lastVisitedAt: 0, permissions: { camera: 'allow' } });
  });

  it('queues an unset permission without a native modal and scopes allow-once to its tab', async () => {
    let request: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]> | undefined;
    configureBrowserSitePermissions({ setPermissionCheckHandler() {}, setPermissionRequestHandler: (handler: Parameters<Session['setPermissionRequestHandler']>[0]) => { request = handler ?? undefined; } } as unknown as Session, () => null, contents => `browser-${contents.id}`);
    const contents = (id: number) => Object.assign(new EventEmitter(), { id, getURL: () => 'https://example.test/', isDestroyed: () => false });
    const first = contents(1), second = contents(2);
    const a = vi.fn(), b = vi.fn();
    request!(first as never, 'geolocation', a, { isMainFrame: true, requestingUrl: 'https://example.test/' });
    request!(second as never, 'geolocation', b, { isMainFrame: true, requestingUrl: 'https://example.test/' });
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(a).not.toHaveBeenCalled();
    expect(getBrowserPermissionRequests()).toHaveLength(2);
    const blocked = { preventDefault: vi.fn() };
    first.emit('before-input-event', blocked);
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const interrupted = waitForBrowserPermissionRequests('browser-1', controller.signal);
    controller.abort();
    await expect(interrupted).rejects.toThrow('aborted');
    expect(getBrowserPermissionRequests()).toHaveLength(2);
    let resumed = false;
    const waiting = waitForBrowserPermissionRequests('browser-1').then(() => { resumed = true; });
    await Promise.resolve();
    expect(resumed).toBe(false);
    resolveBrowserPermissionRequest({ requestId: getBrowserPermissionRequests()[0]!.requestId, decision: 'allow-once' });
    await waiting;
    expect(resumed).toBe(true);
    expect(a).toHaveBeenCalledWith(true);
    first.emit('before-input-event', blocked);
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    expect((await getBrowserSite('https://example.test')).permissions).toEqual({});
    second.emit('did-start-navigation', { isSameDocument: false });
    expect(b).toHaveBeenCalledWith(false);
    expect(getBrowserPermissionRequests()).toHaveLength(0);
  });

  it.each([true, false])('denies display capture without a camera or microphone prompt (agent=%s)', async agent => {
    resetBrowserDialogsForTest();
    configureBrowserDialogs({ isAgentControlled: () => agent });
    let request: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]> | undefined;
    configureBrowserSitePermissions({ setPermissionCheckHandler() {}, setPermissionRequestHandler: (handler: Parameters<Session['setPermissionRequestHandler']>[0]) => { request = handler ?? undefined; } } as unknown as Session, () => null, () => 'browser-1');
    const contents = Object.assign(new EventEmitter(), { id: 1, getURL: () => 'https://example.test/', isDestroyed: () => false });
    const callback = vi.fn();
    request!(contents as never, 'media', callback, { isMainFrame: true, requestingUrl: 'https://example.test/', mediaTypes: [], securityOrigin: 'https://example.test' } as never);
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    expect(getBrowserPermissionRequests()).toEqual([]);
    expect((await getBrowserSite('https://example.test')).permissions).toEqual({});
    expect(takeBrowserNotices('browser-1')).toEqual(agent ? [expect.stringContaining('Screen sharing is not supported')] : []);
    configureBrowserDialogs({ isAgentControlled: () => false });
  });

  it.each([true, false])('denies the Electron 45 display-capture permission without a media prompt (agent=%s)', async agent => {
    resetBrowserDialogsForTest();
    configureBrowserDialogs({ isAgentControlled: () => agent });
    let request: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]> | undefined;
    configureBrowserSitePermissions({ setPermissionCheckHandler() {}, setPermissionRequestHandler: (handler: Parameters<Session['setPermissionRequestHandler']>[0]) => { request = handler ?? undefined; } } as unknown as Session, () => null, () => 'browser-1');
    const contents = Object.assign(new EventEmitter(), { id: 1, getURL: () => 'https://example.test/', isDestroyed: () => false });
    const callback = vi.fn();
    request!(contents as never, 'display-capture', callback, { isMainFrame: true, requestingUrl: 'https://example.test/', mediaTypes: ['video'], securityOrigin: 'https://example.test' } as never);
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    expect(getBrowserPermissionRequests()).toEqual([]);
    expect((await getBrowserSite('https://example.test')).permissions).toEqual({});
    expect(takeBrowserNotices('browser-1')).toEqual(agent ? [expect.stringContaining('Screen sharing is not supported')] : []);
    configureBrowserDialogs({ isAgentControlled: () => false });
  });

  it.each([
    ['without a media type list', {}],
    ['that mixes a known and an unknown media type', { mediaTypes: ['audio', 'unknown'] }],
  ])('denies a media request %s even when camera and microphone are allowed', async (_label, media) => {
    resetBrowserDialogsForTest();
    configureBrowserDialogs({ isAgentControlled: () => true });
    let request: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]> | undefined;
    configureBrowserSitePermissions({ setPermissionCheckHandler() {}, setPermissionRequestHandler: (handler: Parameters<Session['setPermissionRequestHandler']>[0]) => { request = handler ?? undefined; } } as unknown as Session, () => null, () => 'browser-1');
    await updateBrowserSitePermission('https://example.test', 'camera', 'allow');
    await updateBrowserSitePermission('https://example.test', 'microphone', 'allow');
    const contents = Object.assign(new EventEmitter(), { id: 1, getURL: () => 'https://example.test/', isDestroyed: () => false });
    const callback = vi.fn();
    request!(contents as never, 'media', callback, { isMainFrame: true, requestingUrl: 'https://example.test/', ...media } as never);
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    expect(getBrowserPermissionRequests()).toEqual([]);
    expect(takeBrowserNotices('browser-1')).toEqual([]);
    configureBrowserDialogs({ isAgentControlled: () => false });
  });

  it('tells the agent when a frame tries to open an external app', () => {
    resetBrowserDialogsForTest();
    configureBrowserDialogs({ isAgentControlled: () => true });
    let request: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]> | undefined;
    configureBrowserSitePermissions({ setPermissionCheckHandler() {}, setPermissionRequestHandler: (handler: Parameters<Session['setPermissionRequestHandler']>[0]) => { request = handler ?? undefined; } } as unknown as Session, () => null, () => 'browser-1');
    const contents = Object.assign(new EventEmitter(), { id: 1, getURL: () => 'https://example.test/', isDestroyed: () => false });
    const callback = vi.fn();
    request!(contents as never, 'openExternal', callback, { isMainFrame: false, requestingUrl: 'https://example.test/', externalURL: 'zoommtg://join?id=1' } as never);
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    expect(takeBrowserNotices('browser-1')).toEqual([expect.stringContaining('zoommtg: links are blocked')]);
    configureBrowserDialogs({ isAgentControlled: () => false });
  });

  it.each(['allow-always', 'block'] as const)('persists an explicit %s choice and denies closed requests', async decision => {
    let request: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]> | undefined;
    configureBrowserSitePermissions({ setPermissionCheckHandler() {}, setPermissionRequestHandler: (handler: Parameters<Session['setPermissionRequestHandler']>[0]) => { request = handler ?? undefined; } } as unknown as Session, () => null, () => 'browser-1');
    const contents = Object.assign(new EventEmitter(), { id: 1, getURL: () => 'https://example.test/', isDestroyed: () => false });
    const callback = vi.fn();
    request!(contents as never, 'geolocation', callback, { isMainFrame: true, requestingUrl: 'https://example.test/' });
    const requestId = getBrowserPermissionRequests()[0]!.requestId;
    resolveBrowserPermissionRequest({ requestId, decision });
    expect(callback).toHaveBeenCalledWith(decision === 'allow-always');
    expect((await getBrowserSite('https://example.test')).permissions.location).toBe(decision === 'allow-always' ? 'allow' : 'block');
    expect(resolveBrowserPermissionRequest({ requestId, decision: 'allow-once' })).toBe(false);
  });

  it.each([
    ['clipboard-sanitized-write', 'clipboardWrite', 'clipboard-read', 'clipboard'],
    ['midi', 'midi', 'midiSysex', 'midiSysex'],
  ] as const)('keeps an allowed %s grant from covering stronger requests', async (weak, weakKey, strong, strongKey) => {
    let check: NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]> | undefined;
    let request: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]> | undefined;
    configureBrowserSitePermissions({ setPermissionCheckHandler: (handler: Parameters<Session['setPermissionCheckHandler']>[0]) => { check = handler ?? undefined; }, setPermissionRequestHandler: (handler: Parameters<Session['setPermissionRequestHandler']>[0]) => { request = handler ?? undefined; } } as unknown as Session, () => null, () => 'browser-1');
    const contents = Object.assign(new EventEmitter(), { id: 1, getURL: () => 'https://example.test/', isDestroyed: () => false });
    const weakCallback = vi.fn();
    request!(contents as never, weak, weakCallback, { isMainFrame: true, requestingUrl: 'https://example.test/' });
    resolveBrowserPermissionRequest({ requestId: getBrowserPermissionRequests()[0]!.requestId, decision: 'allow-always' });
    expect(weakCallback).toHaveBeenCalledWith(true);
    expect((await getBrowserSite('https://example.test')).permissions).toEqual({ [weakKey]: 'allow' });
    const details = { isMainFrame: true, requestingUrl: 'https://example.test/', securityOrigin: 'https://example.test/' };
    expect(check!(contents as never, weak as never, 'https://example.test', details as never)).toBe(true);
    expect(check!(contents as never, strong as never, 'https://example.test', details as never)).toBe(false);
    const strongCallback = vi.fn();
    request!(contents as never, strong, strongCallback, { isMainFrame: true, requestingUrl: 'https://example.test/' });
    expect(strongCallback).not.toHaveBeenCalled();
    expect(getBrowserPermissionRequests()).toEqual([expect.objectContaining({ permissions: [strongKey] })]);
    resolveBrowserPermissionRequest({ requestId: getBrowserPermissionRequests()[0]!.requestId, decision: 'block' });
  });

  it('denies media checks without an audio or video media type even when camera and microphone are allowed', async () => {
    let check: NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]> | undefined;
    configureBrowserSitePermissions({ setPermissionCheckHandler: (handler: Parameters<Session['setPermissionCheckHandler']>[0]) => { check = handler ?? undefined; }, setPermissionRequestHandler() {} } as unknown as Session, () => null, () => 'browser-1');
    await updateBrowserSitePermission('https://example.test', 'camera', 'allow');
    await updateBrowserSitePermission('https://example.test', 'microphone', 'allow');
    const contents = Object.assign(new EventEmitter(), { id: 1, getURL: () => 'https://example.test/', isDestroyed: () => false });
    const details = { isMainFrame: true, requestingUrl: 'https://example.test/', securityOrigin: 'https://example.test/' };
    expect(check!(contents as never, 'media', 'https://example.test', { ...details, mediaType: 'video' } as never)).toBe(true);
    expect(check!(contents as never, 'media', 'https://example.test', { ...details, mediaType: 'audio' } as never)).toBe(true);
    expect(check!(contents as never, 'media', 'https://example.test', details as never)).toBe(false);
    expect(check!(contents as never, 'media', 'https://example.test', { ...details, mediaType: 'unknown' } as never)).toBe(false);
  });

  it('denies media requests with empty media types even when camera and microphone are allowed', async () => {
    let request: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]> | undefined;
    configureBrowserSitePermissions({ setPermissionCheckHandler() {}, setPermissionRequestHandler: (handler: Parameters<Session['setPermissionRequestHandler']>[0]) => { request = handler ?? undefined; } } as unknown as Session, () => null, () => 'browser-1');
    await updateBrowserSitePermission('https://example.test', 'camera', 'allow');
    await updateBrowserSitePermission('https://example.test', 'microphone', 'allow');
    const contents = Object.assign(new EventEmitter(), { id: 1, getURL: () => 'https://example.test/', isDestroyed: () => false });
    const callback = vi.fn();
    request!(contents as never, 'media', callback, { isMainFrame: true, requestingUrl: 'https://example.test/', mediaTypes: [] });
    expect(callback).toHaveBeenCalledWith(false);
    const absent = vi.fn();
    request!(contents as never, 'media', absent, { isMainFrame: true, requestingUrl: 'https://example.test/' });
    expect(absent).toHaveBeenCalledWith(false);
    expect(getBrowserPermissionRequests()).toEqual([]);
  });

  it('denies a media request that mixes a known and an unknown media type even when the known one is allowed', async () => {
    let request: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]> | undefined;
    configureBrowserSitePermissions({ setPermissionCheckHandler() {}, setPermissionRequestHandler: (handler: Parameters<Session['setPermissionRequestHandler']>[0]) => { request = handler ?? undefined; } } as unknown as Session, () => null, () => 'browser-1');
    await updateBrowserSitePermission('https://example.test', 'microphone', 'allow');
    const contents = Object.assign(new EventEmitter(), { id: 1, getURL: () => 'https://example.test/', isDestroyed: () => false });
    const callback = vi.fn();
    request!(contents as never, 'media', callback, { isMainFrame: true, requestingUrl: 'https://example.test/', mediaTypes: ['audio', 'unknown'] } as never);
    expect(callback).toHaveBeenCalledWith(false);
    expect(getBrowserPermissionRequests()).toEqual([]);
  });

  it('reports permission prompts the user settles from the panel or site settings, but not cancellations', async () => {
    let request: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]> | undefined;
    configureBrowserSitePermissions({ setPermissionCheckHandler() {}, setPermissionRequestHandler: (handler: Parameters<Session['setPermissionRequestHandler']>[0]) => { request = handler ?? undefined; } } as unknown as Session, () => null, contents => `browser-${contents.id}`);
    const contents = (id: number) => Object.assign(new EventEmitter(), { id, getURL: () => 'https://example.test/', isDestroyed: () => false });
    const answered = vi.fn();
    const stop = onBrowserPermissionUserAnswer(answered);
    try {
      const first = contents(1), second = contents(2), third = contents(3);
      request!(first as never, 'geolocation', vi.fn(), { isMainFrame: true, requestingUrl: 'https://example.test/' });
      resolveBrowserPermissionRequest({ requestId: getBrowserPermissionRequests()[0]!.requestId, decision: 'allow-once' });
      expect(answered.mock.calls).toEqual([['browser-1']]);
      const blocked = vi.fn();
      request!(second as never, 'media', blocked, { isMainFrame: true, requestingUrl: 'https://example.test/', mediaTypes: ['video'] });
      await updateBrowserSitePermission('https://example.test', 'camera', 'block');
      expect(blocked).toHaveBeenCalledWith(false);
      expect(answered.mock.calls).toEqual([['browser-1'], ['browser-2']]);
      request!(third as never, 'geolocation', vi.fn(), { isMainFrame: true, requestingUrl: 'https://example.test/' });
      third.emit('destroyed');
      expect(getBrowserPermissionRequests()).toEqual([]);
      expect(answered).toHaveBeenCalledTimes(2);
    } finally { stop(); }
  });

  it('removes only cookies applicable to the selected hostname', async () => {
    await mocks.cookies.withImplementation(async () => [
      { name: 'host', domain: 'a.example.test', hostOnly: true, path: '/', secure: true },
      { name: 'sibling', domain: 'b.example.test', hostOnly: true, path: '/', secure: true },
      { name: 'shared', domain: 'example.test', hostOnly: true, path: '/', secure: true },
      { name: 'shared', domain: '.example.test', hostOnly: false, path: '/account', secure: true },
      { name: 'child', domain: '.child.a.example.test', hostOnly: false, path: '/', secure: false },
    ], async () => {
      expect((await getBrowserSite('https://a.example.test')).cookieCount).toBe(2);
      await clearBrowserSiteData('https://a.example.test');
    });
    expect(mocks.removeCookie.mock.calls).toEqual([
      ['https://a.example.test/', 'host'],
      ['https://a.example.test/account', 'shared'],
    ]);
    expect(mocks.clearData).toHaveBeenCalledWith(expect.objectContaining({ dataTypes: ['cache'] }));
  });

  it('deletes only the chosen origin and keeps its permission choices', async () => {
    await updateBrowserSitePermission('https://example.test', 'notifications', 'block');
    expect(await clearBrowserSiteData('https://example.test/path')).toMatchObject({ permissions: { notifications: 'block' } });
    expect(mocks.clearData).toHaveBeenCalledWith({ origins: ['https://example.test'], dataTypes: ['cache'], originMatchingMode: 'origin-in-all-contexts' });
    expect(mocks.clearStorageData).toHaveBeenCalledWith(expect.objectContaining({ origin: 'https://example.test' }));
    await expect(clearBrowserSiteData('file:///tmp')).rejects.toThrow('Invalid site');
  });
});

it('accepts a permission decision after same-document navigation', () => {
  let request: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]> | undefined;
  configureBrowserSitePermissions({ setPermissionCheckHandler() {}, setPermissionRequestHandler: (handler: Parameters<Session['setPermissionRequestHandler']>[0]) => { request = handler ?? undefined; } } as unknown as Session, () => null, () => 'same-document');
  let url = 'https://example.test/start';
  const contents = Object.assign(new EventEmitter(), { id: 100, getURL: () => url, isDestroyed: () => false });
  const callback = vi.fn();
  request!(contents as never, 'geolocation', callback, { isMainFrame: true, requestingUrl: url });
  const requestId = getBrowserPermissionRequests()[0]!.requestId;
  url = 'https://example.test/next#section';
  contents.emit('did-start-navigation', { isSameDocument: true, isMainFrame: true });
  resolveBrowserPermissionRequest({ requestId, decision: 'allow-once' });
  expect(callback).toHaveBeenCalledWith(true);
});
