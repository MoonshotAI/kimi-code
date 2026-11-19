import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import type { UpdateStatus } from '@moonshot-ai/app-client/composables';

const mocks = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../src/renderer/lib/track', () => ({ track: mocks.track }));

import { createForcedUpgradeController, desktopMinimumVersion, isForcedUpgradeRequired } from '../../src/renderer/lib/forcedUpgrade';

function setup(overrides: { checkVersion?: string; minimum?: string } = {}) {
  const status = ref<UpdateStatus>({ state: 'idle' });
  const download = vi.fn();
  const install = vi.fn().mockResolvedValue(undefined);
  const check = vi.fn().mockResolvedValue({ outcome: 'available', version: overrides.checkVersion ?? '1.2.0' });
  let now = 0;
  const controller = createForcedUpgradeController({
    currentVersion: '1.1.0',
    supported: true,
    status,
    fetchPolicy: async () => ({ desktopMinVersion: overrides.minimum ?? '1.2.0' }),
    check,
    download,
    install,
    now: () => now,
  });
  return {
    controller,
    status,
    check,
    download,
    install,
    advance: (ms: number) => { now += ms; },
  };
}

describe('forced upgrade controller', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

  it('parses the policy and compares stable and prerelease versions', () => {
    expect(desktopMinimumVersion({ desktopMinVersion: '1.2.0' })).toBe('1.2.0');
    expect(desktopMinimumVersion({ desktopMinVersion: 'bad' })).toBeNull();
    expect(isForcedUpgradeRequired('1.1.0', '1.2.0')).toBe(true);
    expect(isForcedUpgradeRequired('1.2.0', '1.2.0')).toBe(false);
    expect(isForcedUpgradeRequired('1.2.0-canary.1', '1.2.0')).toBe(true);
  });

  it('enables skip after ten seconds and does not persist it', async () => {
    const { controller, advance } = setup();
    await controller.start();
    expect(controller.phase.value).toBe('prompt');
    expect(mocks.track).toHaveBeenCalledWith('forced_upgrade_prompt_shown', expect.objectContaining({
      client: 'desktop',
      minimum_version: '1.2.0',
    }));

    controller.skip();
    expect(controller.phase.value).toBe('prompt');
    advance(10_000);
    await vi.advanceTimersByTimeAsync(250);
    controller.skip();
    expect(controller.phase.value).toBe('skipped');
    expect(mocks.track).toHaveBeenCalledWith('forced_upgrade_action', expect.objectContaining({
      action: 'skip',
      trigger: 'initial',
      waited_ms: 10_000,
    }));
    controller.dispose();
  });

  it('blocks skip while downloading and restores it after a failure', async () => {
    const { controller, status, download, advance } = setup();
    await controller.start();
    await controller.upgrade();
    expect(controller.phase.value).toBe('downloading');
    expect(download).toHaveBeenCalledOnce();
    controller.skip();
    expect(controller.phase.value).toBe('downloading');

    status.value = { state: 'error', message: 'network failed' };
    await nextTick();
    expect(controller.phase.value).toBe('error');
    advance(10_000);
    await vi.advanceTimersByTimeAsync(250);
    controller.skip();
    expect(controller.phase.value).toBe('skipped');
    expect(mocks.track).toHaveBeenCalledWith('forced_upgrade_action', expect.objectContaining({
      action: 'skip',
      trigger: 'error',
    }));
    controller.dispose();
  });

  it('rejects an insufficient target before downloading', async () => {
    const { controller, download, advance } = setup({ checkVersion: '1.1.5', minimum: '1.2.0' });
    await controller.start();
    await controller.upgrade();
    expect(controller.phase.value).toBe('error');
    expect(controller.lastErrorClass.value).toBe('target_below_minimum');
    expect(download).not.toHaveBeenCalled();
    advance(10_000);
    await vi.advanceTimersByTimeAsync(250);
    controller.skip();
    expect(controller.phase.value).toBe('skipped');
    controller.dispose();
  });

  it('normalizes an unavailable target to the localized error state', async () => {
    const { controller, check, download } = setup();
    check.mockResolvedValue({ outcome: 'latest' });
    await controller.start();
    await controller.upgrade();
    expect(controller.phase.value).toBe('error');
    expect(controller.errorMessage.value).toBe('target_below_minimum');
    expect(controller.lastErrorClass.value).toBe('target_below_minimum');
    expect(download).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('retries a failed check with an incremented attempt', async () => {
    const { controller, check, download } = setup();
    check.mockRejectedValueOnce(new Error('offline'));
    await controller.start();
    await controller.upgrade();
    expect(controller.phase.value).toBe('error');
    expect(controller.errorStage.value).toBe('check');

    await controller.retry();
    expect(check).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenCalledOnce();
    expect(mocks.track).toHaveBeenCalledWith('forced_upgrade_action', expect.objectContaining({
      action: 'retry',
      trigger: 'error',
      error_stage: 'check',
      attempt: 2,
    }));
    controller.dispose();
  });

  it('downloads and restarts through the existing updater bridge', async () => {
    const { controller, status, install } = setup();
    await controller.start();
    await controller.upgrade();
    status.value = { state: 'downloaded', version: '1.2.0' };
    await nextTick();
    expect(controller.phase.value).toBe('downloaded');
    await controller.restart();
    expect(install).toHaveBeenCalledOnce();
    expect(mocks.track).toHaveBeenCalledWith('forced_upgrade_action', expect.objectContaining({
      action: 'restart',
    }));
    controller.dispose();
  });
});
