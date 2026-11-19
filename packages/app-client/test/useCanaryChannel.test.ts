import { describe, expect, it, vi } from 'vitest';

import { createCanaryTracker, type CanaryInfo } from '../src/composables/useCanaryChannel';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const INFO_ENABLED: CanaryInfo = { enabled: true, isCanaryBuild: true, isRealCanaryBuild: true };

function fakeBridge(info: CanaryInfo = INFO_ENABLED) {
  return {
    getCanaryInfo: vi.fn().mockResolvedValue(info),
    canaryImportStableSettings: vi.fn().mockResolvedValue({ status: 'relaunching' }),
  };
}

describe('createCanaryTracker', () => {
  it('stays hidden with no desktop bridge (web / no-bridge fallback)', async () => {
    const tracker = createCanaryTracker(undefined);
    await flush();
    expect(tracker.enabled.value).toBe(false);
    expect(tracker.isCanaryBuild.value).toBe(false);
  });

  it('adopts the info from the bridge', async () => {
    const tracker = createCanaryTracker(fakeBridge());
    await flush();
    expect(tracker.enabled.value).toBe(true);
    expect(tracker.isCanaryBuild.value).toBe(true);
  });

  it('hides when the main process reports a stable build (enabled=false)', async () => {
    const tracker = createCanaryTracker(fakeBridge({ enabled: false, isCanaryBuild: false, isRealCanaryBuild: false }));
    await flush();
    expect(tracker.enabled.value).toBe(false);
    expect(tracker.isCanaryBuild.value).toBe(false);
  });

  it('adopts isRealCanaryBuild and routes the import action; unavailable without the method', async () => {
    const tracker = createCanaryTracker(fakeBridge());
    await flush();
    expect(tracker.isRealCanaryBuild.value).toBe(true);
    await expect(tracker.importStableSettings()).resolves.toEqual({ status: 'relaunching' });

    const legacy = createCanaryTracker({
      getCanaryInfo: vi.fn().mockResolvedValue(INFO_ENABLED),
    });
    await expect(legacy.importStableSettings()).resolves.toEqual({ status: 'unavailable' });

    const noBridge = createCanaryTracker(undefined);
    await expect(noBridge.importStableSettings()).resolves.toEqual({ status: 'unavailable' });
  });
});
