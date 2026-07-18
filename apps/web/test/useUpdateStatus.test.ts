import { describe, expect, it, vi, beforeEach } from 'vitest';

import { createUpdateTracker, type UpdateStatus } from '../src/composables/useUpdateStatus';

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
    },
    emit,
  };
}

describe('createUpdateTracker', () => {
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
