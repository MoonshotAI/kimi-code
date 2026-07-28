import { EventEmitter } from 'node:events';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { netFetchMock, trackMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  trackMock: vi.fn(),
}));

// updater.ts imports electron / electron-updater / ./window only for the
// production wiring (initAutoUpdater); the unit under test is the injected
// startAutoUpdater state machine. Mock all three so the import stays inert.
vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '1.0.0' },
  net: { fetch: netFetchMock },
}));
vi.mock('electron-updater', () => ({ autoUpdater: {} }));
vi.mock('../../src/main/window', () => ({ sendToRenderer: vi.fn(), markQuitting: vi.fn() }));
vi.mock('../../src/main/track', () => ({ trackDesktopEvent: trackMock }));

import { fetchReleaseNotes, startAutoUpdater, UPDATE_CHECK_TIMED_OUT, type ReleaseNotes, type UpdateStatus } from '../../src/main/updater';
import { log } from '../../src/main/log';
import { markQuitting } from '../../src/main/window';

const markQuittingMock = vi.mocked(markQuitting);

// Two microtask flushes: the notes-fetch .then merge runs after the injected
// promise resolves, so a single await can race depending on the mock's path.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  checkForUpdates = vi.fn().mockResolvedValue(undefined);
  downloadUpdate = vi.fn().mockResolvedValue(undefined);
  quitAndInstall = vi.fn();
}

function setup(overrides: { initialDelayMs?: number; intervalMs?: number; autoDownload?: boolean; fetchNotes?: (version: string) => Promise<ReleaseNotes> } = {}) {
  const updater = new FakeUpdater();
  const sent: UpdateStatus[] = [];
  const controller = startAutoUpdater({
    updater,
    send: (status) => sent.push(status),
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
      isPackaged: false,
    });
    expect(controller).toBeNull();
    expect(updater.listenerCount('update-available')).toBe(0);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('keeps downloads user-initiated by default and keeps install-on-quit, then checks on the initial delay and cadence', () => {
    const { updater, controller } = setup({ initialDelayMs: 1_000, intervalMs: 2_000 });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
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

    // A background check failure never reaches the error state (and never tracks).
    updater.emit('update-not-available');
    trackMock.mockClear();
    updater.emit('error', new NetworkError('feed unreachable'));
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('setAutoDownload flips the flag only — a waiting update still needs the user click, and disabling never cancels in-flight', () => {
    const { updater, controller } = setup({ autoDownload: false });

    // Enabling with a waiting update does NOT start it — the preference only
    // applies to future checks.
    updater.emit('update-available', { version: '1.2.3' });
    controller.setAutoDownload(true);
    expect(updater.autoDownload).toBe(true);
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(controller.getStatus().state).toBe('available');

    // A manual click still starts the download.
    controller.download();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);

    // Disabling mid-flight does not cancel — the download finishes and lands.
    controller.setAutoDownload(false);
    expect(updater.autoDownload).toBe(false);
    updater.emit('update-downloaded', { version: '1.2.3' });
    expect(controller.getStatus().state).toBe('downloaded');

    // Re-enabling while downloaded starts no phantom download.
    controller.setAutoDownload(true);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
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

  it('streams available → downloading → downloaded statuses', () => {
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

    controller.install();
    // quitAndInstall reorders before-quit after the window closes, so install
    // must mark quitting first — otherwise hide-on-close swallows the closes
    // and the update never applies.
    expect(markQuittingMock).toHaveBeenCalled();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(markQuittingMock.mock.invocationCallOrder[0]).toBeLessThan(
      updater.quitAndInstall.mock.invocationCallOrder[0]!,
    );
  });

  it('surfaces an error only when the user-initiated download fails', () => {
    const { updater, sent, controller } = setup();

    updater.emit('update-available', { version: '1.2.3' });
    controller.download();
    updater.emit('error', new Error('network down'));
    expect(sent.at(-1)).toEqual({ state: 'error', version: '1.2.3', message: 'network down' });

    // Retry from the error state re-enters downloading.
    controller.download();
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)).toEqual({ state: 'downloading', version: '1.2.3', percent: 0 });
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

    // A failed download for the pulled version clears too.
    updater.emit('update-available', { version: '1.2.3' });
    controller.download();
    updater.emit('error', new Error('network down'));
    expect(controller.getStatus().state).toBe('error');
    updater.emit('update-not-available');
    expect(sent.at(-1)).toEqual({ state: 'idle' });

    // ...but an in-flight download is left alone.
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

    // The 4h re-check re-announces the same version: state must survive.
    updater.emit('update-available', { version: '1.2.3' });
    expect(controller.getStatus().state).toBe('downloaded');

    // ...but a genuinely newer version still takes over.
    updater.emit('update-available', { version: '1.2.4' });
    expect(controller.getStatus()).toEqual({ state: 'available', version: '1.2.4' });
  });

  it('ignores download/install actions outside their valid states', () => {
    const { updater, controller } = setup();

    controller.download(); // idle
    controller.install(); // idle
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    updater.emit('update-available', { version: '1.2.3' });
    controller.install(); // available, not downloaded yet
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe('manual check (controller.check)', () => {
  it('resolves available when the feed offers a version, and still updates the state machine', async () => {
    const { updater, sent, controller } = setup();

    const promise = controller.check();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    updater.emit('update-available', { version: '1.2.3' });
    await expect(promise).resolves.toEqual({ outcome: 'available', version: '1.2.3' });

    // The persistent listener ran too: the sidebar indicator flow is untouched.
    expect(sent.at(-1)).toEqual({ state: 'available', version: '1.2.3' });
    // One-shot listeners are cleaned up — only the persistent ones remain.
    expect(updater.listenerCount('update-available')).toBe(1);
    expect(updater.listenerCount('update-not-available')).toBe(1);
    expect(updater.listenerCount('update-downloaded')).toBe(1);
    expect(updater.listenerCount('error')).toBe(1);
  });

  it('resolves available (not a timeout) when the version is already downloaded', async () => {
    const { updater, controller } = setup();
    const promise = controller.check();
    // electron-updater re-fires 'update-downloaded' for an already-landed
    // version instead of 'update-available'.
    updater.emit('update-downloaded', { version: '1.2.3' });
    await expect(promise).resolves.toEqual({ outcome: 'available', version: '1.2.3' });
    expect(updater.listenerCount('update-downloaded')).toBe(1);
  });

  it('resolves latest on update-not-available', async () => {
    const { updater, controller } = setup();
    const promise = controller.check();
    updater.emit('update-not-available');
    await expect(promise).resolves.toEqual({ outcome: 'latest' });
  });

  it('resolves error on an error event and on a rejected checkForUpdates', async () => {
    const { updater, controller } = setup();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const promise = controller.check();
    updater.emit('error', new Error('feed unreachable'));
    await expect(promise).resolves.toEqual({ outcome: 'error', message: 'feed unreachable' });
    // The background-swallow path logged the event as usual.
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

    // Later transitions on the same version keep the notes.
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
    // The stale fetch landed after 1.2.4 took over — only the new notes merge.
    expect(controller.getStatus()).toEqual({ state: 'available', version: '1.2.4', releaseNotes: { en: '- New' } });
  });

  it('stays note-less (and quiet) when the fetch comes back empty or fails', async () => {
    const fetchNotes = vi.fn().mockResolvedValue({});
    const { updater, sent, controller } = setup({ fetchNotes });
    updater.emit('update-available', { version: '1.2.3' });
    await flush();
    expect(controller.getStatus()).toEqual({ state: 'available', version: '1.2.3' });
    // An empty notes object never merges — no extra status push.
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

    // The empty first fetch unpinned the version: a later re-announce of the
    // same version retries (e.g. the changelog was backfilled meanwhile).
    updater.emit('update-available', { version: '1.2.3' });
    await flush();
    expect(fetchNotes).toHaveBeenCalledTimes(2);
    expect(controller.getStatus().releaseNotes).toEqual(NOTES);

    // A successful fetch still pins — no third call on further re-announces.
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
    expect(netFetchMock).toHaveBeenCalledWith('https://code.kimi.com/kimi-code/desktop/1.2.3/changelog.zh.md');
    expect(netFetchMock).toHaveBeenCalledWith('https://code.kimi.com/kimi-code/desktop/1.2.3/changelog.en.md');
    // The 404 language is simply absent; the healthy one comes through.
    expect(notes).toEqual({ zh: '- 中文' });
  });

  it('never rejects on network errors', async () => {
    netFetchMock.mockRejectedValue(new Error('network down'));
    await expect(fetchReleaseNotes('1.2.3')).resolves.toEqual({});
  });
});
