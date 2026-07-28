import { describe, expect, it, vi, beforeEach } from 'vitest';

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));

vi.mock('../../src/renderer/lib/track', () => ({ track: trackMock }));

import { createUpdateTracker, type UpdateStatus } from '../../src/renderer/composables/useUpdateStatus';

// Two microtask flushes: the tracker's .then runs after the bridge promise
// resolves, so a single await can race depending on the mock's resolution path.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function fakeBridge(initial: UpdateStatus) {
  const listeners = new Set<(status: UpdateStatus) => void>();
  const emit = (status: UpdateStatus): void => {
    listeners.forEach((cb) => cb(status));
  };
  return {
    bridge: {
      getUpdateStatus: vi.fn().mockResolvedValue(initial),
      onUpdateStatus: vi.fn((cb: (status: UpdateStatus) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      }),
      downloadUpdate: vi.fn().mockResolvedValue(undefined),
      installUpdate: vi.fn().mockResolvedValue(undefined),
      // Manual (click-to-download) preference by default; the auto-mode
      // preference tests get their own describe block below.
      getUpdateAutoDownload: vi.fn().mockResolvedValue(false),
      setUpdateAutoDownload: vi.fn().mockResolvedValue(undefined),
    },
    emit,
  };
}

describe('createUpdateTracker', () => {
  beforeEach(() => {
    trackMock.mockClear();
  });
  it('stays idle with no desktop bridge (web / no-bridge fallback)', async () => {
    const tracker = createUpdateTracker(undefined);
    await flush();
    expect(tracker.status.value).toEqual({ state: 'idle' });
    // Actions are safe no-ops.
    tracker.download();
    tracker.install();
  });

  it('adopts the initial bridge status once the query resolves', async () => {
    const { bridge } = fakeBridge({ state: 'downloaded', version: '1.2.3' });
    const tracker = createUpdateTracker(bridge);
    expect(tracker.status.value).toEqual({ state: 'idle' }); // async: not yet resolved
    await flush();
    expect(tracker.status.value).toEqual({ state: 'downloaded', version: '1.2.3' });
  });

  it('follows pushed available → downloading → downloaded transitions', async () => {
    const { bridge, emit } = fakeBridge({ state: 'idle' });
    const tracker = createUpdateTracker(bridge);
    await flush();

    emit({ state: 'available', version: '1.2.3' });
    expect(tracker.status.value).toEqual({ state: 'available', version: '1.2.3' });
    emit({ state: 'downloading', version: '1.2.3', percent: 42 });
    expect(tracker.status.value).toEqual({ state: 'downloading', version: '1.2.3', percent: 42 });
    emit({ state: 'downloaded', version: '1.2.3' });
    expect(tracker.status.value).toEqual({ state: 'downloaded', version: '1.2.3' });
  });

  it('keeps the idle state when the bridge query rejects', async () => {
    const bridge = {
      getUpdateStatus: vi.fn().mockRejectedValue(new Error('bridge gone')),
      onUpdateStatus: vi.fn(() => () => {}),
      downloadUpdate: vi.fn().mockResolvedValue(undefined),
      installUpdate: vi.fn().mockResolvedValue(undefined),
    };
    const tracker = createUpdateTracker(bridge);
    await flush();
    expect(tracker.status.value).toEqual({ state: 'idle' });
  });

  it('lets a pushed status win over the still-in-flight initial snapshot', async () => {
    let resolveSnapshot!: (s: UpdateStatus) => void;
    const listeners = new Set<(s: UpdateStatus) => void>();
    const bridge = {
      getUpdateStatus: vi.fn(
        () =>
          new Promise<UpdateStatus>((resolve) => {
            resolveSnapshot = resolve;
          }),
      ),
      onUpdateStatus: vi.fn((cb: (s: UpdateStatus) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      }),
      downloadUpdate: vi.fn().mockResolvedValue(undefined),
      installUpdate: vi.fn().mockResolvedValue(undefined),
    };
    const tracker = createUpdateTracker(bridge);

    // The push lands while the snapshot invoke is still in flight; when the
    // snapshot later resolves (stale `idle`) it must NOT clobber the push.
    listeners.forEach((cb) => cb({ state: 'downloaded', version: '1.2.3' }));
    resolveSnapshot({ state: 'idle' });
    await flush();
    expect(tracker.status.value).toEqual({ state: 'downloaded', version: '1.2.3' });
  });

  it('forwards download/install actions to the bridge', async () => {
    const { bridge } = fakeBridge({ state: 'available', version: '1.2.3' });
    const tracker = createUpdateTracker(bridge);
    await flush();

    tracker.download();
    expect(bridge.downloadUpdate).toHaveBeenCalledTimes(1);
    tracker.install();
    expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('passes release notes through from the snapshot and pushes', async () => {
    const { bridge, emit } = fakeBridge({ state: 'available', version: '1.2.3', releaseNotes: { zh: '- 中文' } });
    const tracker = createUpdateTracker(bridge);
    await flush();
    expect(tracker.status.value.releaseNotes).toEqual({ zh: '- 中文' });

    emit({ state: 'available', version: '1.2.3', releaseNotes: { zh: '- 中文', en: '- English' } });
    expect(tracker.status.value.releaseNotes).toEqual({ zh: '- 中文', en: '- English' });
  });
});

describe('manual check', () => {
  it('reports canCheck=false and resolves unsupported without a bridge', async () => {
    const tracker = createUpdateTracker(undefined);
    expect(tracker.canCheck).toBe(false);
    await expect(tracker.check()).resolves.toEqual({ outcome: 'unsupported' });
  });

  it('reports canCheck=false for a bridge that predates checkForUpdates', async () => {
    const { bridge } = fakeBridge({ state: 'idle' });
    const tracker = createUpdateTracker(bridge);
    expect(tracker.canCheck).toBe(false);
    await expect(tracker.check()).resolves.toEqual({ outcome: 'unsupported' });
  });

  it('passes the check through to a capable bridge', async () => {
    const { bridge } = fakeBridge({ state: 'idle' });
    const capable = { ...bridge, checkForUpdates: vi.fn().mockResolvedValue({ outcome: 'latest' }) };
    const tracker = createUpdateTracker(capable);
    expect(tracker.canCheck).toBe(true);
    await expect(tracker.check()).resolves.toEqual({ outcome: 'latest' });
    expect(capable.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('maps a rejected bridge check to an error outcome', async () => {
    const { bridge } = fakeBridge({ state: 'idle' });
    const capable = { ...bridge, checkForUpdates: vi.fn().mockRejectedValue(new Error('ipc down')) };
    const tracker = createUpdateTracker(capable);
    await expect(tracker.check()).resolves.toEqual({ outcome: 'error', message: 'bridge call failed' });
  });

  it('lifts a previous version skip when a manual check finds that version', async () => {
    globalThis.localStorage?.removeItem('kimi-web.update-skipped-version');
    const { bridge } = fakeBridge({ state: 'available', version: '1.2.3' });
    const capable = {
      ...bridge,
      checkForUpdates: vi.fn().mockResolvedValue({ outcome: 'available', version: '1.2.3' }),
    };
    const tracker = createUpdateTracker(capable);
    await flush();

    tracker.skipVersion();
    expect(tracker.visible.value).toBe(false);

    await expect(tracker.check()).resolves.toEqual({ outcome: 'available', version: '1.2.3' });
    // The skip is lifted (state + persisted key), so the sidebar pill the
    // settings hint points to actually appears.
    expect(tracker.visible.value).toBe(true);
    expect(globalThis.localStorage?.getItem('kimi-web.update-skipped-version') ?? null).toBeNull();
    globalThis.localStorage?.removeItem('kimi-web.update-skipped-version');
  });
});

describe('visibility & version skip', () => {
  beforeEach(() => {
    try {
      globalThis.localStorage?.removeItem('kimi-web.update-skipped-version');
    } catch {
      // storage unavailable in this environment — in-memory behavior still holds
    }
  });

  it('is invisible when idle and visible for an actionable state', async () => {
    const { bridge, emit } = fakeBridge({ state: 'idle' });
    const tracker = createUpdateTracker(bridge);
    await flush();
    expect(tracker.visible.value).toBe(false);

    emit({ state: 'available', version: '1.2.3' });
    expect(tracker.visible.value).toBe(true);
  });

  it('hides a skipped available version until a different one appears', async () => {
    const { bridge, emit } = fakeBridge({ state: 'available', version: '1.2.3' });
    const tracker = createUpdateTracker(bridge);
    await flush();
    expect(tracker.visible.value).toBe(true);

    tracker.skipVersion();
    expect(tracker.visible.value).toBe(false);

    emit({ state: 'available', version: '1.2.4' });
    expect(tracker.visible.value).toBe(true);
  });

  it('does not skip non-available states', async () => {
    const { bridge, emit } = fakeBridge({ state: 'downloaded', version: '1.2.3' });
    const tracker = createUpdateTracker(bridge);
    await flush();

    tracker.skipVersion(); // no-op outside `available`
    expect(tracker.visible.value).toBe(true);
    emit({ state: 'available', version: '1.2.3' });
    expect(tracker.visible.value).toBe(true);
  });

  it('remembers the skip across tracker instances when storage is available', async () => {
    if (globalThis.localStorage === undefined) {
      return;
    }
    const { bridge } = fakeBridge({ state: 'available', version: '1.2.3' });
    const first = createUpdateTracker(bridge);
    await flush();
    first.skipVersion();

    const second = createUpdateTracker(bridge);
    await flush();
    expect(second.visible.value).toBe(false);
  });
});

describe('auto-download mode', () => {
  it('keeps every non-idle state visible — background progress and failures surface too', async () => {
    const { bridge, emit } = fakeBridge({ state: 'idle' });
    bridge.getUpdateAutoDownload.mockResolvedValue(true);
    const tracker = createUpdateTracker(bridge);
    await flush();
    expect(tracker.autoDownload.value).toBe(true);

    emit({ state: 'available', version: '1.2.3' });
    expect(tracker.visible.value).toBe(true);
    emit({ state: 'downloading', version: '1.2.3', percent: 42 });
    expect(tracker.visible.value).toBe(true);
    emit({ state: 'downloaded', version: '1.2.3' });
    expect(tracker.visible.value).toBe(true);
    // A failed background download surfaces with a retry path (the next
    // scheduled check retries on its own too).
    emit({ state: 'error', version: '1.2.3', message: 'network down' });
    expect(tracker.visible.value).toBe(true);
  });

  it('flipping the toggle never changes visibility of the current update', async () => {
    const { bridge } = fakeBridge({ state: 'downloading', version: '1.2.3', percent: 42 });
    bridge.getUpdateAutoDownload.mockResolvedValue(true);
    const tracker = createUpdateTracker(bridge);
    await flush();
    expect(tracker.visible.value).toBe(true);

    tracker.setAutoDownload(false);
    expect(bridge.setUpdateAutoDownload).toHaveBeenCalledWith(false);
    await flush();
    expect(trackMock).toHaveBeenCalledWith('settings_changed', {
      key: 'update-auto-download',
      value: 'off',
    });
    expect(tracker.autoDownload.value).toBe(false);
    expect(tracker.visible.value).toBe(true);

    tracker.setAutoDownload(true);
    expect(bridge.setUpdateAutoDownload).toHaveBeenCalledWith(true);
    await flush();
    expect(trackMock).toHaveBeenLastCalledWith('settings_changed', {
      key: 'update-auto-download',
      value: 'on',
    });
    expect(trackMock).toHaveBeenCalledTimes(2);
    expect(tracker.visible.value).toBe(true);
  });

  it('reports canToggleAutoDownload=false without a bridge or with a legacy one', async () => {
    expect(createUpdateTracker(undefined).canToggleAutoDownload).toBe(false);

    const { bridge } = fakeBridge({ state: 'idle' });
    // A bridge that predates the auto-download toggle methods.
    const legacy = { ...bridge, getUpdateAutoDownload: undefined, setUpdateAutoDownload: undefined };
    const tracker = createUpdateTracker(legacy);
    expect(tracker.canToggleAutoDownload).toBe(false);
    // The default (disabled) stands in for the unreadable preference.
    expect(tracker.autoDownload.value).toBe(false);
  });
});
