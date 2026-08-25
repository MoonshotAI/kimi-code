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

import { fetchReleaseNotes, startAutoUpdater, updateChannelFromVersion, UPDATE_CHECK_TIMED_OUT, type ReleaseNotes, type UpdateController, type UpdateStatus } from '../../src/main/updater';
import { log } from '../../src/main/log';
import { setServerRegionSource } from '../../src/main/region';
import { markQuitting } from '../../src/main/window';

const markQuittingMock = vi.mocked(markQuitting);

// Microtask flushes: the notes-fetch .then merge and the feed-ready chain
// (source wait → apply feed → check) take several hops, so a single await
// can race depending on the mock's path.
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
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

  it('keeps downloads user-initiated by default and keeps install-on-quit, then checks on the initial delay and cadence', async () => {
    const { updater, controller } = setup({ initialDelayMs: 1_000, intervalMs: 2_000 });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    await flush(); // the serialized check chain runs one microtask behind
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
    await flush(); // the one-shot listeners attach when the chain link runs
    updater.emit('update-available', { version: '1.2.3' });
    await expect(promise).resolves.toEqual({ outcome: 'available', version: '1.2.3' });
    // The serialized check chain ran by the time the waiter settled.
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

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
    await flush();
    // electron-updater re-fires 'update-downloaded' for an already-landed
    // version instead of 'update-available'.
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
    expect(netFetchMock).toHaveBeenCalledWith('https://code.kimi.com/kimi-code/desktop/binaries/1.2.3/changelog.zh.md');
    expect(netFetchMock).toHaveBeenCalledWith('https://code.kimi.com/kimi-code/desktop/binaries/1.2.3/changelog.en.md');
    // The 404 language is simply absent; the healthy one comes through.
    expect(notes).toEqual({ zh: '- 中文' });
  });

  it('never rejects on network errors', async () => {
    netFetchMock.mockRejectedValue(new Error('network down'));
    await expect(fetchReleaseNotes('1.2.3')).resolves.toEqual({});
  });
});

describe('serialized check chain', () => {
  it('a hung check does not park the chain — later rounds skip instead of overlapping', async () => {
    // A long initial delay keeps the scheduled check out of the manual window.
    const { updater, controller } = setup({ initialDelayMs: 120_000 });
    updater.checkForUpdates.mockImplementationOnce(() => new Promise<void>(() => {}));

    const first = controller.check();
    await vi.advanceTimersByTimeAsync(31_000); // the manual UI timeout settles first
    await expect(first).resolves.toEqual({ outcome: 'error', message: UPDATE_CHECK_TIMED_OUT });

    // The chain link releases at its 60s bound, but the wedged attempt is
    // still alive underneath — the next round waits it out (bounded) instead
    // of starting a second, overlapping checkForUpdates.
    const second = controller.check();
    await vi.advanceTimersByTimeAsync(30_000); // t+61 — the second waiter times out
    await expect(second).resolves.toEqual({ outcome: 'error', message: UPDATE_CHECK_TIMED_OUT });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    // The round's own gate bound expires: it skips, the queue advances, and
    // still no second checkForUpdates has gone out.
    await vi.advanceTimersByTimeAsync(60_000); // t+121
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
    await vi.advanceTimersByTimeAsync(31_000); // the first waiter times out
    await expect(first).resolves.toEqual({ outcome: 'error', message: UPDATE_CHECK_TIMED_OUT });

    let secondResult: Awaited<ReturnType<typeof controller.check>> | undefined;
    const second = controller.check().then((result) => {
      secondResult = result;
      return result;
    });
    await vi.advanceTimersByTimeAsync(29_000); // t+60 — the chain link releases

    // The first attempt settles late and its event fires while the second
    // round is still waiting it out — before any of its listeners exist.
    settleFirst();
    updater.emit('update-not-available');
    await vi.advanceTimersByTimeAsync(0); // the gate's macrotask drain
    await Promise.resolve();
    expect(secondResult).toBeUndefined();

    // The second round then starts its own check and reports ITS outcome.
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    updater.emit('update-available', { version: '1.2.3' });
    await expect(second).resolves.toEqual({ outcome: 'available', version: '1.2.3' });
    controller.stop();
  });
});

describe('late region source follow-up', () => {
  // region.ts module state is shared file-wide and this describe runs BEFORE
  // the feed describe's beforeEach records a source, so the source is still
  // null here and every round below exhausts its source-wait bound.
  it('re-checks once when the source lands late, and not at all after stop()', async () => {
    const makeController = (): { updater: FakeUpdaterWithFeed; controller: UpdateController } => {
      const updater = new FakeUpdaterWithFeed();
      const controller = startAutoUpdater({
        updater,
        send: () => {},
        isPackaged: true,
        initialDelayMs: 600_000, // keep scheduled checks out of the manual timeline
        intervalMs: 600_000,
        resolveFeedUrl: vi.fn().mockResolvedValue('https://code.kimi.ai/kimi-code/desktop/'),
      });
      if (controller === null) {
        throw new Error('expected a controller for a packaged app');
      }
      return { updater, controller };
    };

    // A: one expired round arms its follow-up; stop() must suppress it.
    const a = makeController();
    void a.controller.check();
    await vi.advanceTimersByTimeAsync(15_000); // the source-wait bound expires → armed
    expect(a.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    a.controller.stop();

    // B: two expired rounds still arm only ONE follow-up.
    const b = makeController();
    void b.controller.check();
    await vi.advanceTimersByTimeAsync(15_000); // round 1 expires → armed
    void b.controller.check();
    await vi.advanceTimersByTimeAsync(15_000); // round 2 expires → no re-arm
    expect(b.updater.checkForUpdates).toHaveBeenCalledTimes(2);

    // The source finally lands: B gets exactly one follow-up check, A none.
    setServerRegionSource('http://127.0.0.1:12345');
    await flush();
    expect(a.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(b.updater.checkForUpdates).toHaveBeenCalledTimes(3);
    b.controller.stop();
  });
});

describe('feed switching (resolveFeedUrl)', () => {
  beforeEach(() => {
    // The feed path waits for the region source before any check — record
    // one up front (the refresh it kicks off fails harmlessly: netFetchMock
    // answers undefined, the previous cache keeps holding).
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
    // The feed is repointed BEFORE the check goes out.
    expect(updater.setFeedURL.mock.invocationCallOrder[0]).toBeLessThan(
      updater.checkForUpdates.mock.invocationCallOrder[0]!,
    );

    // An unchanged resolution is not re-applied on the next check.
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(updater.setFeedURL).toHaveBeenCalledTimes(1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);

    // A changed region re-points the feed.
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
    // setFeedURL replaces the provider configuration wholesale — without an
    // explicit channel an alpha build would silently poll latest*.yml.
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://code.kimi.com/kimi-code/desktop/',
      channel: 'alpha',
    });
    controller.stop();
  });

  it('derives the update channel from the app version (electron-builder rule)', () => {
    expect(updateChannelFromVersion('0.0.21-alpha.0')).toBe('alpha');
    expect(updateChannelFromVersion('0.0.21-beta.3')).toBe('beta');
    expect(updateChannelFromVersion('0.0.21')).toBe('latest');
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

    vi.advanceTimersByTime(1_000); // the scheduled check starts (hangs)
    await flush();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    const manual = controller.check();
    // The scheduled check's outcome fires before the manual listeners exist.
    updater.emit('update-not-available');
    releaseScheduled();
    await flush();
    // The manual check starts only now, behind the scheduled one.
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
    // A long initial delay keeps the scheduled check out of the manual window.
    const { updater, controller } = setupFeed(resolveFeedUrl, { initialDelayMs: 120_000 });

    const promise = controller.check();
    vi.advanceTimersByTime(30_000); // the manual timeout settles first
    await expect(promise).resolves.toEqual({ outcome: 'error', message: UPDATE_CHECK_TIMED_OUT });

    // When the feed finally resolves, the stale continuation must not start
    // a check or attach listeners nobody is waiting for.
    releaseFeed('https://code.kimi.ai/kimi-code/desktop/');
    await flush();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.listenerCount('update-available')).toBe(1); // persistent only
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
