import { EventEmitter } from 'node:events';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// updater.ts imports electron / electron-updater / ./window only for the
// production wiring (initAutoUpdater); the unit under test is the injected
// startAutoUpdater state machine. Mock all three so the import stays inert.
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('electron-updater', () => ({ autoUpdater: {} }));
vi.mock('../../src/main/window', () => ({ sendToRenderer: vi.fn(), markQuitting: vi.fn() }));

import { startAutoUpdater, type UpdateStatus } from '../../src/main/updater';
import { markQuitting } from '../../src/main/window';

const markQuittingMock = vi.mocked(markQuitting);

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  checkForUpdates = vi.fn().mockResolvedValue(undefined);
  downloadUpdate = vi.fn().mockResolvedValue(undefined);
  quitAndInstall = vi.fn();
}

function setup(overrides: { initialDelayMs?: number; intervalMs?: number } = {}) {
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

  it('disables autoDownload and keeps install-on-quit, then checks on the initial delay and cadence', () => {
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

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
    expect(updater.listenerCount('error')).toBe(1);
  });

  it('resolves latest on update-not-available', async () => {
    const { updater, controller } = setup();
    const promise = controller.check();
    updater.emit('update-not-available');
    await expect(promise).resolves.toEqual({ outcome: 'latest' });
  });

  it('resolves error on an error event and on a rejected checkForUpdates', async () => {
    const { updater, controller } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

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
    await expect(promise).resolves.toEqual({ outcome: 'error', message: 'check timed out' });
  });
});
