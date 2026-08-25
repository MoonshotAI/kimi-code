import { describe, expect, it, vi } from 'vitest';

import { createCanaryTracker, type CanaryInfo, type CanaryStatus } from '../src/composables/useCanaryChannel';

// Two microtask flushes: the tracker's .then runs after the bridge promise
// resolves, so a single await can race depending on the mock's resolution path.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const INFO_ENABLED: CanaryInfo = { enabled: true, isCanaryBuild: true, gh: 'ok', actionsUrl: 'https://example.com/actions' };

function fakeBridge(initial: CanaryStatus, info: CanaryInfo = INFO_ENABLED) {
  const listeners = new Set<(status: CanaryStatus) => void>();
  const emit = (status: CanaryStatus): void => {
    listeners.forEach((cb) => cb(status));
  };
  return {
    bridge: {
      getCanaryStatus: vi.fn().mockResolvedValue(initial),
      onCanaryStatus: vi.fn((cb: (status: CanaryStatus) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      }),
      getCanaryInfo: vi.fn().mockResolvedValue(info),
      checkCanaryUpdate: vi.fn().mockResolvedValue({ outcome: 'latest' }),
      downloadCanaryUpdate: vi.fn().mockResolvedValue(undefined),
      openCanaryDownload: vi.fn().mockResolvedValue(undefined),
      triggerCanaryBuild: vi.fn().mockResolvedValue({ ok: true }),
    },
    emit,
  };
}

describe('createCanaryTracker', () => {
  it('stays hidden with no desktop bridge (web / no-bridge fallback)', async () => {
    const tracker = createCanaryTracker(undefined);
    await flush();
    expect(tracker.enabled.value).toBe(false);
    expect(tracker.status.value).toEqual({ state: 'idle' });
    expect(tracker.visible.value).toBe(false);
    await expect(tracker.check()).resolves.toEqual({ outcome: 'error', message: 'no canary bridge' });
    await expect(tracker.triggerBuild()).resolves.toEqual({ ok: false, error: 'no canary bridge' });
    // Actions are safe no-ops.
    tracker.download();
    tracker.openDownload();
  });

  it('hides entirely when the main process reports a stable build (enabled=false)', async () => {
    const { bridge, emit } = fakeBridge({ state: 'idle' }, { enabled: false, isCanaryBuild: false, gh: 'ok', actionsUrl: '' });
    const tracker = createCanaryTracker(bridge);
    await flush();
    expect(tracker.enabled.value).toBe(false);
    // Even a pushed available state stays hidden on a stable build.
    emit({ state: 'available', version: '1.2.3-canary.4', tag: 'v1.2.3-canary.4' });
    expect(tracker.visible.value).toBe(false);
  });

  it('adopts the info and follows pushed transitions; pill shows for non-idle states', async () => {
    const { bridge, emit } = fakeBridge({ state: 'idle' });
    const tracker = createCanaryTracker(bridge);
    await flush();
    expect(tracker.enabled.value).toBe(true);
    expect(tracker.gh.value).toBe('ok');
    expect(tracker.actionsUrl.value).toBe(INFO_ENABLED.actionsUrl);

    emit({ state: 'available', version: '1.2.3-canary.4', tag: 'v1.2.3-canary.4' });
    expect(tracker.visible.value).toBe(true);

    emit({ state: 'downloading', version: '1.2.3-canary.4', tag: 'v1.2.3-canary.4' });
    expect(tracker.visible.value).toBe(true);

    emit({ state: 'downloaded', version: '1.2.3-canary.4', tag: 'v1.2.3-canary.4', path: '/tmp/x.dmg' });
    expect(tracker.visible.value).toBe(true);

    emit({ state: 'idle' });
    expect(tracker.visible.value).toBe(false);
  });

  it('skip hides the available pill until a different version appears', async () => {
    const { bridge, emit } = fakeBridge({ state: 'idle' });
    const tracker = createCanaryTracker(bridge);
    await flush();

    emit({ state: 'available', version: '1.2.3-canary.4', tag: 'v1.2.3-canary.4' });
    tracker.skipVersion();
    expect(tracker.visible.value).toBe(false);

    // Same version again: still hidden. A newer one lifts the skip.
    emit({ state: 'available', version: '1.2.3-canary.4', tag: 'v1.2.3-canary.4' });
    expect(tracker.visible.value).toBe(false);
    emit({ state: 'available', version: '1.2.3-canary.5', tag: 'v1.2.3-canary.5' });
    expect(tracker.visible.value).toBe(true);
  });

  it('manual check lifts the skip when it finds the skipped version', async () => {
    const { bridge, emit } = fakeBridge({ state: 'idle' });
    const tracker = createCanaryTracker(bridge);
    await flush();

    emit({ state: 'available', version: '1.2.3-canary.4', tag: 'v1.2.3-canary.4' });
    tracker.skipVersion();
    expect(tracker.visible.value).toBe(false);

    bridge.checkCanaryUpdate.mockResolvedValueOnce({ outcome: 'available', version: '1.2.3-canary.4' });
    await expect(tracker.check()).resolves.toEqual({ outcome: 'available', version: '1.2.3-canary.4' });
    expect(tracker.visible.value).toBe(true);
  });

  it('wires download / openDownload / triggerBuild to the bridge and degrades failures', async () => {
    const { bridge } = fakeBridge({ state: 'idle' });
    const tracker = createCanaryTracker(bridge);
    await flush();

    tracker.download();
    expect(bridge.downloadCanaryUpdate).toHaveBeenCalledOnce();
    tracker.openDownload();
    expect(bridge.openCanaryDownload).toHaveBeenCalledOnce();
    await expect(tracker.triggerBuild()).resolves.toEqual({ ok: true });

    bridge.triggerCanaryBuild.mockRejectedValueOnce(new Error('boom'));
    await expect(tracker.triggerBuild()).resolves.toEqual({ ok: false, error: 'bridge call failed' });
    bridge.checkCanaryUpdate.mockRejectedValueOnce(new Error('boom'));
    await expect(tracker.check()).resolves.toEqual({ outcome: 'error', message: 'bridge call failed' });
  });
});
