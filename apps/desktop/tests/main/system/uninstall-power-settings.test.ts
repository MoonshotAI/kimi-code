import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lock: vi.fn(), ready: vi.fn(), exit: vi.fn(), restore: vi.fn() }));
vi.mock('electron', () => ({ app: { requestSingleInstanceLock: mocks.lock, whenReady: mocks.ready, exit: mocks.exit } }));
vi.mock('../../../src/main/system/prevent-lid-sleep', () => ({ setLidSleepPreventionEnabled: mocks.restore }));
import { restorePowerSettingsForUninstall } from '../../../src/main/system/uninstall-power-settings';

const platform = process.platform;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.lock.mockReturnValue(true);
  mocks.ready.mockResolvedValue(undefined);
  mocks.restore.mockResolvedValue(undefined);
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
});
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform, configurable: true }); });

it('returns success only after power settings have been restored', async () => {
  let finish!: () => void;
  mocks.restore.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  const pending = restorePowerSettingsForUninstall();
  await Promise.resolve();
  expect(mocks.restore).toHaveBeenCalledWith(false);
  expect(mocks.exit).not.toHaveBeenCalled();
  finish();
  await pending;
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
});

it('blocks uninstall if restoration fails or elevation is cancelled', async () => {
  mocks.restore.mockRejectedValue(new Error('cancelled'));
  await restorePowerSettingsForUninstall();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(1);
});

it('refuses to restore while another app instance can change settings', async () => {
  mocks.lock.mockReturnValue(false);
  await restorePowerSettingsForUninstall();
  expect(mocks.restore).not.toHaveBeenCalled();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(1);
});
