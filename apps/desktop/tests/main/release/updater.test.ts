import { EventEmitter } from 'node:events';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { netFetchMock, trackMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  trackMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '1.0.0' },
  net: { fetch: netFetchMock },
}));
vi.mock('electron-updater', () => ({ autoUpdater: {} }));
vi.mock('../../../src/main/window/main-window', () => ({ sendToRenderer: vi.fn(), markQuitting: vi.fn() }));
vi.mock('../../../src/main/diagnostics/track', () => ({ trackDesktopEvent: trackMock, trySendDesktopEvent: vi.fn() }));

import { fetchReleaseNotes, startAutoUpdater, updateChannelFromVersion, UPDATE_CHECK_TIMED_OUT, type ReleaseNotes, type RestartDecision, type UpdateController, type UpdateStatus } from '../../../src/main/release/updater';
import { log } from '../../../src/main/diagnostics/log';
import { setServerRegionSource } from '../../../src/main/server/region';
import { markQuitting } from '../../../src/main/window/main-window';
import { isUpdateRolloutEligible, UNCOVERED_ROLLOUT_DELAY_SECONDS, rolloutBucket, rolloutDelayForBucket, type UpdateRolloutInfo } from '../../../src/main/release/update-rollout';

const confirmRestartMock = vi.fn<() => Promise<RestartDecision>>();
const prepareSessionContinueMock = vi.fn<(sessionIds: readonly string[]) => void>();
const restartDeps = { confirmRestart: confirmRestartMock, prepareSessionContinue: prepareSessionContinueMock };
const markQuittingMock = vi.mocked(markQuitting);

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  isUserWithinRollout?: (info: UpdateRolloutInfo) => boolean | Promise<boolean>;
  checkForUpdates = vi.fn().mockResolvedValue(undefined);
  downloadUpdate = vi.fn().mockResolvedValue(undefined);
  quitAndInstall = vi.fn();
}

class FakeUpdaterWithFeed extends FakeUpdater {
  setFeedURL = vi.fn();
}

function setup(overrides: { initialDelayMs?: number; intervalMs?: number; autoDownload?: boolean; fetchNotes?: (version: string) => Promise<ReleaseNotes> } = {}) {
  const updater = new FakeUpdater();
  const sent: UpdateStatus[] = [];
  const controller = startAutoUpdater({
    updater,
    send: (status) => sent.push(status),
    ...restartDeps,
    resolveDeviceId: () => 'device-a',
    isPackaged: true,
    ...overrides,
  });
  if (controller === null) {
    throw new Error('expected a controller for a packaged app');
  }
  return { updater, sent, controller };
}

beforeEach(() => {
  vi.useFakeTimers();
  trackMock.mockClear();
  confirmRestartMock.mockReset().mockResolvedValue({ proceed: true, continueSessionIds: [] });
  prepareSessionContinueMock.mockReset();
  markQuittingMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startAutoUpdater', () => {
  it('is a no-op for unpackaged (dev) runs', () => {
    const updater = new FakeUpdater();
    const controller = startAutoUpdater({
      updater,
      send: () => {},
      ...restartDeps,
      isPackaged: false,
    });
    expect(controller).toBeNull();
    expect(updater.listenerCount('update-available')).toBe(0);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('keeps downloads user-initiated by default and keeps install-on-quit, then checks on the initial delay and cadence', async () => {
    const { updater, controller } = setup({ initialDelayMs: 1_000, intervalMs: 2_000 });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    await flush();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await flush();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);

    controller.stop();
    vi.advanceTimersByTime(10_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('enables background autoDownload when opted in', () => {
    const { updater } = setup({ autoDownload: true });
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it('tracks state transitions, not per-chunk download progress', () => {
    const { updater } = setup();
    updater.emit('update-available', { version: '1.2.3', releaseDate: '2026-07-27' });
    updater.emit('download-progress', { percent: 10.2 });
    updater.emit('download-progress', { percent: 55.6 });
    updater.emit('update-downloaded', { version: '1.2.3', releaseDate: '2026-07-27' });

    expect(trackMock.mock.calls).toEqual([
      [
        'update_status_changed',
        { state: 'available', from_version: '1.0.0', to_version: '1.2.3', prev_state: 'idle' },
      ],
      [
        'update_status_changed',
        { state: 'downloading', from_version: '1.0.0', to_version: '1.2.3', prev_state: 'available' },
      ],
      [
        'update_status_changed',
        { state: 'downloaded', from_version: '1.0.0', to_version: '1.2.3', prev_state: 'downloading' },
      ],
    ]);
  });

  it('attaches error_class only to the error transition', () => {
    const { updater, controller } = setup();
    updater.emit('update-available', { version: '1.2.3' });
    controller.download();
    trackMock.mockClear();

    class NetworkError extends Error {
      override name = 'NetworkError';
    }
    updater.emit('error', new NetworkError('network down'));

    expect(trackMock).toHaveBeenCalledWith('update_status_changed', {
      state: 'error',
      from_version: '1.0.0',
      to_version: '1.2.3',
      prev_state: 'downloading',
      error_class: 'NetworkError',
    });

    updater.emit('update-not-available');
    trackMock.mockClear();
    updater.emit('error', new NetworkError('feed unreachable'));
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('setAutoDownload flips the flag only — a waiting update still needs the user click, and disabling never cancels in-flight', () => {
    const { updater, controller } = setup({ autoDownload: false });

    updater.emit('update-available', { version: '1.2.3' });
    controller.setAutoDownload(true);
    expect(updater.autoDownload).toBe(true);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(controller.getStatus().state).toBe('available');

    controller.download();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);

    controller.setAutoDownload(false);
    expect(updater.autoDownload).toBe(false);
    updater.emit('update-downloaded', { version: '1.2.3' });
    expect(controller.getStatus().state).toBe('downloaded');

    controller.setAutoDownload(true);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not start a duplicate manual download while auto-download owns an available update', async () => {
    const { updater, controller } = setup({ autoDownload: true });
    let finishDownload!: () => void;
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', { version: '1.2.3' });
      return { downloadPromise: new Promise<void>((resolve) => { finishDownload = resolve; }) };
    });
    const checking = controller.check();
    await checking;

    controller.download();

    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(controller.getStatus()).toEqual({ state: 'downloading', version: '1.2.3', percent: 0 });
    finishDownload();
    controller.stop();
  });

  it('setAutoDownload(true) does not retry a failed download', () => {
    const { updater, controller } = setup({ autoDownload: false });
    updater.emit('update-available', { version: '1.2.3' });
    controller.download();
    updater.emit('error', new Error('network down'));
    expect(controller.getStatus().state).toBe('error');

    controller.setAutoDownload(true);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(controller.getStatus().state).toBe('error');
  });

  it('streams available → downloading → downloaded statuses', async () => {
    const { updater, sent, controller } = setup();

    updater.emit('update-available', { version: '1.2.3', releaseDate: '2026-07-18T00:00:00.000Z' });
    expect(sent.at(-1)).toEqual({
      state: 'available',
      version: '1.2.3',
      releaseDate: '2026-07-18T00:00:00.000Z',
    });

    controller.download();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)).toEqual({
      state: 'downloading',
      version: '1.2.3',
      releaseDate: '2026-07-18T00:00:00.000Z',
      percent: 0,
    });

    updater.emit('download-progress', { percent: 42.4 });
    expect(sent.at(-1)).toEqual({
      state: 'downloading',
      version: '1.2.3',
      releaseDate: '2026-07-18T00:00:00.000Z',
      percent: 42,
    });

    updater.emit('update-downloaded', { version: '1.2.3', releaseDate: '2026-07-18T00:00:00.000Z' });
    expect(sent.at(-1)).toEqual({
      state: 'downloaded',
      version: '1.2.3',
      releaseDate: '2026-07-18T00:00:00.000Z',
    });
    expect(controller.getStatus()).toEqual({
      state: 'downloaded',
      version: '1.2.3',
      releaseDate: '2026-07-18T00:00:00.000Z',
    });

    await controller.install();
    expect(confirmRestartMock).toHaveBeenCalledOnce();
    expect(prepareSessionContinueMock).toHaveBeenCalledExactlyOnceWith([]);
    expect(markQuittingMock).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(confirmRestartMock.mock.invocationCallOrder[0]).toBeLessThan(
      prepareSessionContinueMock.mock.invocationCallOrder[0]!,
    );
    expect(prepareSessionContinueMock.mock.invocationCallOrder[0]).toBeLessThan(
      markQuittingMock.mock.invocationCallOrder[0]!,
    );
    expect(markQuittingMock.mock.invocationCallOrder[0]).toBeLessThan(
      updater.quitAndInstall.mock.invocationCallOrder[0]!,
    );
  });

  it('records the sessions chosen in the restart prompt before installing', async () => {
    const { updater, controller } = setup();
    updater.emit('update-downloaded', { version: '1.2.3' });
    confirmRestartMock.mockResolvedValue({ proceed: true, continueSessionIds: ['s1', 's2'] });

    await controller.install();

    expect(prepareSessionContinueMock).toHaveBeenCalledExactlyOnceWith(['s1', 's2']);
    expect(prepareSessionContinueMock.mock.invocationCallOrder[0]).toBeLessThan(
      updater.quitAndInstall.mock.invocationCallOrder[0]!,
    );
  });

  it('still installs when recording the sessions to continue fails', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { updater, controller } = setup();
    updater.emit('update-downloaded', { version: '1.2.3' });
    confirmRestartMock.mockResolvedValue({ proceed: true, continueSessionIds: ['s1', 's2'] });
    prepareSessionContinueMock.mockImplementation(() => {
      throw new Error('disk full');
    });

    await controller.install();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    expect(markQuittingMock).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    warn.mockRestore();
  });

  it('installs without continuing sessions when the restart confirmation fails', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { updater, controller } = setup();
    updater.emit('update-downloaded', { version: '1.2.3' });
    confirmRestartMock.mockRejectedValue(new Error('server gone'));

    await controller.install();

    expect(prepareSessionContinueMock).toHaveBeenCalledExactlyOnceWith([]);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    warn.mockRestore();
  });

  it('keeps the update ready when quit confirmation is cancelled and allows retrying', async () => {
    const { updater, controller } = setup();
    updater.emit('update-downloaded', { version: '1.2.3' });
    confirmRestartMock.mockResolvedValue({ proceed: false, continueSessionIds: [] });

    await controller.install();

    expect(controller.getStatus().state).toBe('downloaded');
    expect(prepareSessionContinueMock).not.toHaveBeenCalled();
    expect(markQuittingMock).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    confirmRestartMock.mockResolvedValue({ proceed: true, continueSessionIds: [] });
    await controller.install();
    expect(markQuittingMock).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('runs only one quit check while update installation is pending', async () => {
    const { updater, controller } = setup();
    updater.emit('update-downloaded', { version: '1.2.3' });
    let resolveCheck!: (decision: RestartDecision) => void;
    confirmRestartMock.mockReturnValue(new Promise((resolve) => {
      resolveCheck = resolve;
    }));

    const first = controller.install();
    const second = controller.install();
    expect(confirmRestartMock).toHaveBeenCalledOnce();

    resolveCheck({ proceed: true, continueSessionIds: [] });
    await Promise.all([first, second]);
    expect(markQuittingMock).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('surfaces an error only when the user-initiated download fails', () => {
    const { updater, sent, controller } = setup();

    updater.emit('update-available', { version: '1.2.3' });
    controller.download();
    updater.emit('error', new Error('network down'));
    expect(sent.at(-1)).toEqual({ state: 'error', version: '1.2.3', message: 'network down' });

    controller.download();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)).toEqual({ state: 'downloading', version: '1.2.3', percent: 0 });
  });

  it('handles an automatic download rejection while preserving the download error state', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { updater, controller } = setup();
    const error = new Error('net::ERR_NETWORK_CHANGED');
    let rejectDownload!: (reason: Error) => void;
    const downloadPromise = new Promise<unknown>((_resolve, reject) => {
      rejectDownload = reject;
    });
    updater.checkForUpdates.mockResolvedValueOnce({ downloadPromise });
    const unhandledRejection = vi.fn();
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => {});
    process.on('unhandledRejection', unhandledRejection);

    try {
      updater.emit('update-available', { version: '1.2.3' });
      updater.emit('download-progress', { percent: 10 });
      const checking = controller.check();
      await flush();

      updater.emit('error', error);
      rejectDownload(error);
      await expect(checking).resolves.toEqual({ outcome: 'error', message: error.message });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledWith('[kimi-desktop] update download failed', error);
      expect(controller.getStatus()).toEqual({ state: 'error', version: '1.2.3', message: error.message });
    } finally {
      controller.stop();
      process.off('unhandledRejection', unhandledRejection);
      errorLog.mockRestore();
    }
  });

  it('swallows background check failures without disturbing the idle state', () => {
    const { updater, sent, controller } = setup();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    updater.emit('error', new Error('feed unreachable'));
    expect(controller.getStatus()).toEqual({ state: 'idle' });
    expect(sent).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('clears a stale available state when the feed rolls back (update-not-available)', () => {
    const { updater, sent, controller } = setup();

    updater.emit('update-available', { version: '1.2.3' });
    expect(controller.getStatus().state).toBe('available');

    updater.emit('update-not-available');
    expect(sent.at(-1)).toEqual({ state: 'idle' });

    updater.emit('update-available', { version: '1.2.3' });
    controller.download();
    updater.emit('error', new Error('network down'));
    expect(controller.getStatus().state).toBe('error');
    updater.emit('update-not-available');
    expect(sent.at(-1)).toEqual({ state: 'idle' });

    updater.emit('update-available', { version: '1.2.3' });
    controller.download();
    updater.emit('update-not-available');
    expect(controller.getStatus().state).toBe('downloading');
  });

  it('never regresses an in-flight version back to available on a repeated announce', () => {
    const { updater, controller } = setup();

    updater.emit('update-available', { version: '1.2.3' });
    controller.download();
    updater.emit('update-downloaded', { version: '1.2.3' });

    updater.emit('update-available', { version: '1.2.3' });
    expect(controller.getStatus().state).toBe('downloaded');

    updater.emit('update-available', { version: '1.2.4' });
    expect(controller.getStatus()).toEqual({ state: 'available', version: '1.2.4' });
  });

  it('ignores download/install actions outside their valid states', async () => {
    const { updater, controller } = setup();

    controller.download();
    await controller.install();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    updater.emit('update-available', { version: '1.2.3' });
    await controller.install();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe('manual check (controller.check)', () => {
  it('resolves available when the feed offers a version, and still updates the state machine', async () => {
    const { updater, sent, controller } = setup();

    const promise = controller.check();
    await flush();
    updater.emit('update-available', { version: '1.2.3' });
    await expect(promise).resolves.toEqual({ outcome: 'available', version: '1.2.3' });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    expect(sent.at(-1)).toEqual({ state: 'available', version: '1.2.3' });
    expect(updater.listenerCount('update-available')).toBe(1);
    expect(updater.listenerCount('update-not-available')).toBe(1);
    expect(updater.listenerCount('update-downloaded')).toBe(1);
    expect(updater.listenerCount('error')).toBe(1);
  });

  it('resolves available (not a timeout) when the version is already downloaded', async () => {
    const { updater, controller } = setup();
    const promise = controller.check();
    await flush();
    updater.emit('update-downloaded', { version: '1.2.3' });
    await expect(promise).resolves.toEqual({ outcome: 'available', version: '1.2.3' });
    expect(updater.listenerCount('update-downloaded')).toBe(1);
  });

  it('resolves latest on update-not-available', async () => {
    const { updater, controller } = setup();
    const promise = controller.check();
    await flush();
    updater.emit('update-not-available');
    await expect(promise).resolves.toEqual({ outcome: 'latest' });
  });

  it('resolves error on an error event and on a rejected checkForUpdates', async () => {
    const { updater, controller } = setup();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const promise = controller.check();
    await flush();
    updater.emit('error', new Error('feed unreachable'));
    await expect(promise).resolves.toEqual({ outcome: 'error', message: 'feed unreachable' });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();

    updater.checkForUpdates.mockRejectedValueOnce(new Error('boom'));
    await expect(controller.check()).resolves.toEqual({ outcome: 'error', message: 'boom' });
  });

  it('times out instead of hanging forever', async () => {
    const { controller } = setup();
    const promise = controller.check();
    vi.advanceTimersByTime(30_000);
    await expect(promise).resolves.toEqual({ outcome: 'error', message: UPDATE_CHECK_TIMED_OUT });
  });
});

describe('release notes', () => {
  const NOTES: ReleaseNotes = { zh: '- 修复甲', en: '- Fixed A' };

  it('fetches notes once a version is known and keeps them across same-version transitions', async () => {
    const fetchNotes = vi.fn().mockResolvedValue(NOTES);
    const { updater, sent } = setup({ fetchNotes });

    updater.emit('update-available', { version: '1.2.3', releaseDate: '2026-07-18T00:00:00.000Z' });
    expect(fetchNotes).toHaveBeenCalledWith('1.2.3');
    await flush();
    expect(sent.at(-1)).toEqual({
      state: 'available',
      version: '1.2.3',
      releaseDate: '2026-07-18T00:00:00.000Z',
      releaseNotes: NOTES,
    });

    updater.emit('download-progress', { percent: 42 });
    expect(sent.at(-1)?.releaseNotes).toEqual(NOTES);
    updater.emit('update-downloaded', { version: '1.2.3' });
    expect(sent.at(-1)?.releaseNotes).toEqual(NOTES);
  });

  it('fetches once per version, and again for a genuinely newer one', async () => {
    const fetchNotes = vi.fn().mockResolvedValue(NOTES);
    const { updater } = setup({ fetchNotes });

    updater.emit('update-available', { version: '1.2.3' });
    updater.emit('update-available', { version: '1.2.3' });
    expect(fetchNotes).toHaveBeenCalledTimes(1);

    updater.emit('update-available', { version: '1.2.4' });
    expect(fetchNotes).toHaveBeenCalledTimes(2);
    expect(fetchNotes).toHaveBeenLastCalledWith('1.2.4');
  });

  it('drops notes fetched for a version the status has moved on from', async () => {
    let resolveOld!: (notes: ReleaseNotes) => void;
    const fetchNotes = vi.fn().mockImplementation((version: string) =>
      version === '1.2.3'
        ? new Promise<ReleaseNotes>((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve({ en: '- New' }),
    );
    const { updater, controller } = setup({ fetchNotes });

    updater.emit('update-available', { version: '1.2.3' });
    updater.emit('update-available', { version: '1.2.4' });
    resolveOld({ en: '- Old' });
    await flush();
    await flush();
    expect(controller.getStatus()).toEqual({ state: 'available', version: '1.2.4', releaseNotes: { en: '- New' } });
  });

  it('stays note-less (and quiet) when the fetch comes back empty or fails', async () => {
    const fetchNotes = vi.fn().mockResolvedValue({});
    const { updater, sent, controller } = setup({ fetchNotes });
    updater.emit('update-available', { version: '1.2.3' });
    await flush();
    expect(controller.getStatus()).toEqual({ state: 'available', version: '1.2.3' });
    expect(sent).toHaveLength(1);

    fetchNotes.mockRejectedValue(new Error('cdn down'));
    updater.emit('update-available', { version: '1.2.4' });
    await flush();
    expect(controller.getStatus()).toEqual({ state: 'available', version: '1.2.4' });
  });

  it('retries the fetch on a later event after an empty result or failure', async () => {
    const fetchNotes = vi.fn().mockResolvedValueOnce({}).mockResolvedValue(NOTES);
    const { updater, controller } = setup({ fetchNotes });

    updater.emit('update-available', { version: '1.2.3' });
    await flush();
    expect(controller.getStatus().releaseNotes).toBeUndefined();

    updater.emit('update-available', { version: '1.2.3' });
    await flush();
    expect(fetchNotes).toHaveBeenCalledTimes(2);
    expect(controller.getStatus().releaseNotes).toEqual(NOTES);

    updater.emit('update-available', { version: '1.2.3' });
    expect(fetchNotes).toHaveBeenCalledTimes(2);
  });

  it('clears the notes when the version disappears (feed rollback)', async () => {
    const fetchNotes = vi.fn().mockResolvedValue(NOTES);
    const { updater, controller } = setup({ fetchNotes });
    updater.emit('update-available', { version: '1.2.3' });
    await flush();
    expect(controller.getStatus().releaseNotes).toEqual(NOTES);

    updater.emit('update-not-available');
    expect(controller.getStatus()).toEqual({ state: 'idle' });
  });

  it('works without an injected fetchNotes (no fetch, no notes)', async () => {
    const { updater, controller } = setup();
    updater.emit('update-available', { version: '1.2.3' });
    await flush();
    expect(controller.getStatus()).toEqual({ state: 'available', version: '1.2.3' });
  });
});

describe('fetchReleaseNotes (production fetch)', () => {
  beforeEach(() => {
    netFetchMock.mockReset();
  });

  it('pulls changelog.<lang>.md from the version directory, tolerating per-language failures', async () => {
    netFetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/changelog.zh.md')
        ? { ok: true, text: async () => '- 中文' }
        : { ok: false, status: 404, text: async () => 'not found' },
    );

    const notes = await fetchReleaseNotes('1.2.3');
    expect(netFetchMock).toHaveBeenCalledWith('https://code.kimi.com/kimi-code/desktop/binaries/1.2.3/changelog.zh.md');
    expect(netFetchMock).toHaveBeenCalledWith('https://code.kimi.com/kimi-code/desktop/binaries/1.2.3/changelog.en.md');
    expect(notes).toEqual({ zh: '- 中文' });
  });

  it('never rejects on network errors', async () => {
    netFetchMock.mockRejectedValue(new Error('network down'));
    await expect(fetchReleaseNotes('1.2.3')).resolves.toEqual({});
  });
});

describe('serialized check chain', () => {
  it('a hung check does not park the chain — later rounds skip instead of overlapping', async () => {
    const { updater, controller } = setup({ initialDelayMs: 120_000 });
    updater.checkForUpdates.mockImplementationOnce(() => new Promise<void>(() => {}));

    const first = controller.check();
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(first).resolves.toEqual({ outcome: 'error', message: UPDATE_CHECK_TIMED_OUT });

    const second = controller.check();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(second).resolves.toEqual({ outcome: 'error', message: UPDATE_CHECK_TIMED_OUT });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('a late-settling check cannot feed its outcome to the next check', async () => {
    const { updater, controller } = setup({ initialDelayMs: 120_000 });
    let settleFirst!: () => void;
    updater.checkForUpdates
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settleFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const first = controller.check();
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(first).resolves.toEqual({ outcome: 'error', message: UPDATE_CHECK_TIMED_OUT });

    let secondResult: Awaited<ReturnType<typeof controller.check>> | undefined;
    const second = controller.check().then((result) => {
      secondResult = result;
      return result;
    });
    await vi.advanceTimersByTimeAsync(29_000);

    settleFirst();
    updater.emit('update-not-available');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(secondResult).toBeUndefined();

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    updater.emit('update-available', { version: '1.2.3' });
    await expect(second).resolves.toEqual({ outcome: 'available', version: '1.2.3' });
    controller.stop();
  });
});

describe('late region source follow-up', () => {
  it('re-checks once when the source lands late, and not at all after stop()', async () => {
    const makeController = (): { updater: FakeUpdaterWithFeed; controller: UpdateController } => {
      const updater = new FakeUpdaterWithFeed();
      const controller = startAutoUpdater({
        updater,
        send: () => {},
        ...restartDeps,
        isPackaged: true,
        initialDelayMs: 600_000,
        intervalMs: 600_000,
        resolveFeedUrl: vi.fn().mockResolvedValue('https://code.kimi.ai/kimi-code/desktop/'),
      });
      if (controller === null) {
        throw new Error('expected a controller for a packaged app');
      }
      return { updater, controller };
    };

    const a = makeController();
    void a.controller.check();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(a.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    a.controller.stop();

    const b = makeController();
    void b.controller.check();
    await vi.advanceTimersByTimeAsync(15_000);
    void b.controller.check();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(b.updater.checkForUpdates).toHaveBeenCalledTimes(2);

    setServerRegionSource('http://127.0.0.1:12345');
    await flush();
    expect(a.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(b.updater.checkForUpdates).toHaveBeenCalledTimes(3);
    b.controller.stop();
  });
});

describe('feed switching (resolveFeedUrl)', () => {
  beforeEach(() => {
    setServerRegionSource('http://127.0.0.1:12345');
  });

  function setupFeed(
    resolveFeedUrl: () => Promise<string>,
    opts: { initialDelayMs?: number; updateChannel?: string } = {},
  ) {
    const updater = new FakeUpdaterWithFeed();
    const sent: UpdateStatus[] = [];
    const controller = startAutoUpdater({
      updater,
      send: (status) => sent.push(status),
      ...restartDeps,
      isPackaged: true,
      initialDelayMs: opts.initialDelayMs ?? 1_000,
      intervalMs: 60_000,
      resolveFeedUrl,
      updateChannel: opts.updateChannel,
    });
    if (controller === null) {
      throw new Error('expected a controller for a packaged app');
    }
    return { updater, sent, controller };
  }

  it('applies the resolved feed before the scheduled check, re-applying only on change', async () => {
    const resolveFeedUrl = vi.fn().mockResolvedValue('https://code.kimi.ai/kimi-code/desktop/');
    const { updater, controller } = setupFeed(resolveFeedUrl);

    vi.advanceTimersByTime(1_000);
    await flush();
    expect(updater.setFeedURL).toHaveBeenCalledTimes(1);
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://code.kimi.ai/kimi-code/desktop/',
      channel: 'latest',
    });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.setFeedURL.mock.invocationCallOrder[0]).toBeLessThan(
      updater.checkForUpdates.mock.invocationCallOrder[0]!,
    );

    vi.advanceTimersByTime(60_000);
    await flush();
    expect(updater.setFeedURL).toHaveBeenCalledTimes(1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);

    resolveFeedUrl.mockResolvedValue('https://code.kimi.com/kimi-code/desktop/');
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(updater.setFeedURL).toHaveBeenCalledTimes(2);
    expect(updater.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://code.kimi.com/kimi-code/desktop/',
      channel: 'latest',
    });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3);
    controller.stop();
  });

  it('carries the build channel onto the repointed feed (prerelease builds)', async () => {
    const resolveFeedUrl = vi.fn().mockResolvedValue('https://code.kimi.com/kimi-code/desktop/');
    const { updater, controller } = setupFeed(resolveFeedUrl, { updateChannel: 'alpha' });

    vi.advanceTimersByTime(1_000);
    await flush();
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://code.kimi.com/kimi-code/desktop/',
      channel: 'alpha',
    });
    controller.stop();
  });

  it('maps stable and other prerelease builds to the latest channel and keeps canary/preview on their own', () => {
    expect(updateChannelFromVersion('0.0.21-alpha.0')).toBe('latest');
    expect(updateChannelFromVersion('0.0.21')).toBe('latest');
    expect(updateChannelFromVersion('0.0.21-canary.5')).toBe('canary');
    expect(updateChannelFromVersion('0.0.21-preview.2')).toBe('preview');
  });

  it('keeps the baked-in feed and still checks when resolution fails', async () => {
    const resolveFeedUrl = vi.fn().mockRejectedValue(new Error('server down'));
    const { updater, controller } = setupFeed(resolveFeedUrl);

    vi.advanceTimersByTime(1_000);
    await flush();
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it('serializes a manual check behind a scheduled one, with no event cross-talk', async () => {
    const resolveFeedUrl = vi.fn().mockResolvedValue('https://code.kimi.ai/kimi-code/desktop/');
    const { updater, controller } = setupFeed(resolveFeedUrl, { initialDelayMs: 1_000 });
    let releaseScheduled!: () => void;
    updater.checkForUpdates
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => { releaseScheduled = () => resolve(); }),
      )
      .mockResolvedValue(undefined);

    vi.advanceTimersByTime(1_000);
    await flush();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    const manual = controller.check();
    updater.emit('update-not-available');
    releaseScheduled();
    await flush();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    updater.emit('update-not-available');
    await expect(manual).resolves.toEqual({ outcome: 'latest' });
    controller.stop();
  });

  it('does not start the check when the feed wait outlasts the manual timeout', async () => {
    let releaseFeed!: (url: string) => void;
    const resolveFeedUrl = vi.fn(
      () => new Promise<string>((resolve) => { releaseFeed = resolve; }),
    );
    const { updater, controller } = setupFeed(resolveFeedUrl, { initialDelayMs: 120_000 });

    const promise = controller.check();
    vi.advanceTimersByTime(30_000);
    await expect(promise).resolves.toEqual({ outcome: 'error', message: UPDATE_CHECK_TIMED_OUT });

    releaseFeed('https://code.kimi.ai/kimi-code/desktop/');
    await flush();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.listenerCount('update-available')).toBe(1);
    controller.stop();
  });

  it('resolves the feed before a manual check too', async () => {
    const resolveFeedUrl = vi.fn().mockResolvedValue('https://code.kimi.ai/kimi-code/desktop/');
    const { updater, controller } = setupFeed(resolveFeedUrl);

    const pending = controller.check();
    await flush();
    updater.emit('update-not-available');
    await expect(pending).resolves.toEqual({ outcome: 'latest' });
    expect(updater.setFeedURL).toHaveBeenCalledTimes(1);
    expect(updater.setFeedURL.mock.invocationCallOrder[0]).toBeLessThan(
      updater.checkForUpdates.mock.invocationCallOrder[0]!,
    );
    controller.stop();
  });
});

describe('update rollout', () => {
  const publishedAt = '2026-06-12T00:00:00.000Z';
  const publishedAtMs = Date.parse(publishedAt);
  const standardRollout = [
    { percent: 30, delaySeconds: 0 },
    { percent: 30, delaySeconds: 43_200 },
    { percent: 40, delaySeconds: 86_400 },
  ];

  it('matches the CLI bucket regression vectors', () => {
    expect(rolloutBucket('device-a', '1.0.0')).toBe(65);
    expect(rolloutBucket('device-b', '1.0.0')).toBe(76);
    expect(rolloutBucket('fixed-device', '2.0.0')).toBe(26);
    expect(rolloutBucket('device-a', '1.0.1')).toBe(79);
  });

  it('maps batch boundaries and uncovered buckets to the expected delays', () => {
    expect(rolloutDelayForBucket(standardRollout, 0)).toBe(0);
    expect(rolloutDelayForBucket(standardRollout, 29)).toBe(0);
    expect(rolloutDelayForBucket(standardRollout, 30)).toBe(43_200);
    expect(rolloutDelayForBucket(standardRollout, 59)).toBe(43_200);
    expect(rolloutDelayForBucket(standardRollout, 60)).toBe(86_400);
    expect(rolloutDelayForBucket(standardRollout, 99)).toBe(86_400);
    expect(rolloutDelayForBucket([{ percent: 30, delaySeconds: 0 }], 99)).toBe(UNCOVERED_ROLLOUT_DELAY_SECONDS);
    expect(rolloutDelayForBucket([{ percent: 100, delaySeconds: 999_999 }], 50)).toBe(999_999);
    expect(rolloutDelayForBucket([{ percent: 30, delaySeconds: 172_800 }], 99)).toBe(172_800);
    expect(rolloutDelayForBucket([], 99)).toBe(0);
  });

  it('holds a delayed cohort until its eligibility time', () => {
    const info: UpdateRolloutInfo = {
      version: '2.0.0',
      publishedAt,
      rollout: [{ percent: 100, delaySeconds: 43_200 }],
    };
    expect(isUpdateRolloutEligible(info, 'device-a', new Date(publishedAtMs + 43_199_000))).toBe(false);
    expect(isUpdateRolloutEligible(info, 'device-a', new Date(publishedAtMs + 43_200_000))).toBe(true);
  });

  it('fails open for missing or malformed rollout metadata', () => {
    const beforeRelease = new Date(publishedAtMs - 60_000);
    expect(isUpdateRolloutEligible({ version: '2.0.0' }, 'device-a', beforeRelease)).toBe(true);
    expect(isUpdateRolloutEligible({ version: '2.0.0', publishedAt, rollout: null }, 'device-a', beforeRelease)).toBe(true);
    expect(isUpdateRolloutEligible({ version: '2.0.0', publishedAt, rollout: [{ percent: 101, delaySeconds: 0 }] }, 'device-a', beforeRelease)).toBe(true);
    expect(isUpdateRolloutEligible({ version: '2.0.0', publishedAt: 'invalid', rollout: [] }, 'device-a', beforeRelease)).toBe(true);
  });

  it('treats an empty rollout as immediate regardless of publishedAt', () => {
    const beforeRelease = new Date(publishedAtMs - 60_000);
    expect(isUpdateRolloutEligible({ version: '2.0.0', publishedAt, rollout: [] }, 'device-a', beforeRelease)).toBe(true);
    expect(isUpdateRolloutEligible({ version: '2.0.0', publishedAt: '2999-01-01T00:00:00.000Z', rollout: [] }, 'device-a', beforeRelease)).toBe(true);
  });

  it('gates scheduled checks before auto-download but bypasses rollout for manual checks', async () => {
    vi.setSystemTime(publishedAtMs);
    const { updater, controller } = setup({ initialDelayMs: 1_000, autoDownload: true });
    const info: UpdateRolloutInfo = {
      version: '2.0.0',
      publishedAt,
      rollout: [{ percent: 100, delaySeconds: 86_400 }],
    };
    updater.checkForUpdates.mockImplementation(async () => {
      const eligible = await updater.isUserWithinRollout!(info);
      if (!eligible) {
        updater.emit('update-not-available', info);
        return;
      }
      updater.emit('update-available', info);
      if (updater.autoDownload) await updater.downloadUpdate();
    });

    vi.advanceTimersByTime(1_000);
    await flush();
    expect(controller.getStatus().state).toBe('idle');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();

    await expect(controller.check()).resolves.toEqual({ outcome: 'available', version: '2.0.0' });
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    controller.stop();
  });

  it('keeps a manually approved version eligible across scheduled checks until downloaded', async () => {
    vi.setSystemTime(publishedAtMs);
    const { updater, controller } = setup({ initialDelayMs: 1_000, intervalMs: 1_000 });
    const info: UpdateRolloutInfo = {
      version: '2.0.0',
      publishedAt,
      rollout: [{ percent: 100, delaySeconds: 86_400 }],
    };
    updater.checkForUpdates.mockImplementation(async () => {
      const eligible = await updater.isUserWithinRollout!(info);
      updater.emit(eligible ? 'update-available' : 'update-not-available', info);
    });

    vi.advanceTimersByTime(1_000);
    await flush();
    expect(controller.getStatus().state).toBe('idle');

    await expect(controller.check()).resolves.toEqual({ outcome: 'available', version: '2.0.0' });
    const callsAfterManualCheck = updater.checkForUpdates.mock.calls.length;
    vi.advanceTimersByTime(1_000);
    await flush();
    expect(controller.getStatus().state).toBe('available');
    expect(updater.checkForUpdates.mock.calls.length).toBeGreaterThan(callsAfterManualCheck);
    expect(updater.isUserWithinRollout!({ ...info, version: '2.0.1' })).toBe(false);

    controller.download();
    updater.emit('update-downloaded', info);
    expect(updater.isUserWithinRollout!(info)).toBe(false);
    controller.stop();
  });
});
