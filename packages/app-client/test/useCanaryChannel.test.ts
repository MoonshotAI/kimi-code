import { describe, expect, it, vi } from 'vitest';

import { createCanaryTracker, type CanaryInfo } from '../src/composables/useCanaryChannel';

// Two microtask flushes: the tracker's .then runs after the bridge promise
// resolves, so a single await can race depending on the mock's resolution path.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const INFO_ENABLED: CanaryInfo = { enabled: true, isCanaryBuild: true, gh: 'ok', actionsUrl: 'https://example.com/actions' };

function fakeBridge(info: CanaryInfo = INFO_ENABLED) {
  return {
    getCanaryInfo: vi.fn().mockResolvedValue(info),
    triggerCanaryBuild: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe('createCanaryTracker', () => {
  it('stays hidden with no desktop bridge (web / no-bridge fallback)', async () => {
    const tracker = createCanaryTracker(undefined);
    await flush();
    expect(tracker.enabled.value).toBe(false);
    expect(tracker.isCanaryBuild.value).toBe(false);
    await expect(tracker.triggerBuild()).resolves.toEqual({ ok: false, error: 'no canary bridge' });
  });

  it('adopts the info from the bridge', async () => {
    const tracker = createCanaryTracker(fakeBridge());
    await flush();
    expect(tracker.enabled.value).toBe(true);
    expect(tracker.isCanaryBuild.value).toBe(true);
    expect(tracker.gh.value).toBe('ok');
    expect(tracker.actionsUrl.value).toBe(INFO_ENABLED.actionsUrl);
  });

  it('hides when the main process reports a stable build (enabled=false)', async () => {
    const tracker = createCanaryTracker(fakeBridge({ enabled: false, isCanaryBuild: false, gh: 'ok', actionsUrl: '' }));
    await flush();
    expect(tracker.enabled.value).toBe(false);
    expect(tracker.isCanaryBuild.value).toBe(false);
  });

  it('degrades trigger failures to an error result', async () => {
    const bridge = fakeBridge();
    const tracker = createCanaryTracker(bridge);
    await flush();
    await expect(tracker.triggerBuild()).resolves.toEqual({ ok: true });
    bridge.triggerCanaryBuild.mockRejectedValueOnce(new Error('boom'));
    await expect(tracker.triggerBuild()).resolves.toEqual({ ok: false, error: 'bridge call failed' });
  });
});
