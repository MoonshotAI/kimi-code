import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: vi.fn(() => '1.0.5-canary.108.1.gaaaaaaaa') },
  send: vi.fn(),
  feed: vi.fn(),
  check: vi.fn(async () => undefined),
  download: vi.fn(async () => undefined),
  install: vi.fn(),
  restart: {
    confirmRestart: vi.fn(async () => ({ proceed: true, continueSessionIds: [] })),
    prepareSessionContinue: vi.fn(),
  },
  fetch: vi.fn().mockResolvedValue({ ok: true, text: async () => 'Canary notes' }),
  region: { value: 'mainland-cn' },
}));
vi.mock('electron', () => ({ app: mocks.app, net: { fetch: mocks.fetch } }));
vi.mock('../../../src/main/window/main-window', () => ({ sendToRenderer: mocks.send, markQuitting: vi.fn() }));
vi.mock('../../../src/main/diagnostics/track', () => ({ trackDesktopEvent: vi.fn(), trySendDesktopEvent: vi.fn() }));
vi.mock('../../../src/main/app/ui-state', () => ({ isUpdateAutoDownloadEnabled: () => false, setUpdateAutoDownloadEnabled: vi.fn() }));
vi.mock('../../../src/main/server/region', () => ({
  refreshServerRegion: async () => mocks.region.value,
  serverRegionProfile: (region = mocks.region.value) => ({ cdnBase: region === 'global' ? 'https://code.kimi.ai/kimi-code' : 'https://code.kimi.com/kimi-code' }),
  whenServerRegionSource: async () => true,
}));
vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events');
  return { autoUpdater: Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: true,
    isUpdateSupported: vi.fn(async () => true),
    setFeedURL: mocks.feed,
    checkForUpdates: mocks.check,
    downloadUpdate: mocks.download,
    quitAndInstall: mocks.install,
  }) };
});

import { autoUpdater } from 'electron-updater';
import { initAutoUpdater, getUpdateStatus, requestUpdateCheck, requestUpdateDownload, requestUpdateInstall } from '../../../src/main/release/updater';

const updater = autoUpdater as typeof autoUpdater & EventEmitter;
const supported = updater.isUpdateSupported;

afterEach(() => {
  updater.removeAllListeners();
  updater.isUpdateSupported = supported;
  updater.allowPrerelease = false;
  mocks.app.getVersion.mockReturnValue('1.0.5-canary.108.1.gaaaaaaaa');
  mocks.region.value = 'mainland-cn';
  vi.clearAllMocks();
  vi.useRealTimers();
});

for (const region of ['mainland-cn', 'global']) {
  it(`checks the ${region} CDN automatically and manually, downloads and installs without GitHub`, async () => {
    vi.useFakeTimers();
    mocks.region.value = region;
    initAutoUpdater(mocks.restart);
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.autoDownload).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.feed).toHaveBeenCalledWith({ provider: 'generic', url: `https://${region === 'global' ? 'code.kimi.ai' : 'code.kimi.com'}/kimi-code/desktop/`, channel: 'canary' });
    expect(mocks.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mocks.check).toHaveBeenCalledTimes(3);
    const checking = requestUpdateCheck();
    await vi.advanceTimersByTimeAsync(0);
    updater.emit('update-available', { version: '1.0.6-canary.109.1.gbbbbbbbb' });
    await expect(checking).resolves.toMatchObject({ outcome: 'available' });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetch).toHaveBeenCalledWith(expect.stringContaining('/binaries/1.0.6-canary.109.1.gbbbbbbbb/changelog.zh.md'));
    requestUpdateDownload();
    expect(mocks.download).toHaveBeenCalledOnce();
    updater.emit('update-downloaded', { version: '1.0.6-canary.109.1.gbbbbbbbb' });
    expect(getUpdateStatus().state).toBe('downloaded');
    await requestUpdateInstall();
    expect(mocks.install).toHaveBeenCalled();
  });
}

describe('channel isolation', () => {
  it('rejects Canary and Preview candidates on stable', async () => {
    vi.useFakeTimers();
    mocks.app.getVersion.mockReturnValue('1.0.5');
    initAutoUpdater(mocks.restart);
    const info = (version: string) => ({ version, files: [], path: '', sha512: '', releaseDate: '' });
    await expect(Promise.resolve(updater.isUpdateSupported(info('2.0.0-canary.1')))).resolves.toBe(false);
    await expect(Promise.resolve(updater.isUpdateSupported(info('2.0.0-preview.1')))).resolves.toBe(false);
    await expect(Promise.resolve(updater.isUpdateSupported(info('1.0.6')))).resolves.toBe(true);
    expect(updater.allowDowngrade).toBe(false);
  });
  it('preserves existing prerelease eligibility on the latest channel', () => {
    vi.useFakeTimers();
    mocks.app.getVersion.mockReturnValue('1.0.5-alpha.1');
    updater.allowPrerelease = true;
    initAutoUpdater(mocks.restart);
    expect(updater.allowPrerelease).toBe(true);
  });
  it('rejects stable and Preview updates on Canary, preserving platform requirements', async () => {
    vi.useFakeTimers();
    initAutoUpdater(mocks.restart);
    const info = (version: string) => ({ version, files: [], path: '', sha512: '', releaseDate: '' });
    await expect(Promise.resolve(updater.isUpdateSupported(info('1.0.6')))).resolves.toBe(false);
    await expect(Promise.resolve(updater.isUpdateSupported(info('1.0.6-preview.1')))).resolves.toBe(false);
    await expect(Promise.resolve(updater.isUpdateSupported(info('1.0.6-canary.1')))).resolves.toBe(true);
    expect(supported).toHaveBeenCalledOnce();
  });

  it('keeps stable on latest and disables Preview updates', async () => {
    vi.useFakeTimers();
    mocks.app.getVersion.mockReturnValue('1.0.5');
    initAutoUpdater(mocks.restart);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(updater.allowPrerelease).toBe(false);
    expect(mocks.feed).toHaveBeenCalledWith(expect.objectContaining({ channel: 'latest' }));
    expect(mocks.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3.5 * 60 * 60 * 1000);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    vi.clearAllMocks();
    mocks.app.getVersion.mockReturnValue('1.0.5-preview.1');
    initAutoUpdater(mocks.restart);
    expect(mocks.feed).not.toHaveBeenCalled();
  });
});
