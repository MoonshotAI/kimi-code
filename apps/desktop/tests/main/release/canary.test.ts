import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { appMock } = vi.hoisted(() => ({
  appMock: {
    isPackaged: true,
    getVersion: vi.fn(() => '0.0.20-canary.1'),
  },
}));

vi.mock('electron', () => ({ app: appMock }));

import { getCanaryInfo } from '../../../src/main/release/canary';
import { isCanaryVersion, isCanaryChannelEnabled, isCanaryDisplay, isDevCanaryOverride, windowsAppId } from '../../../src/main/release/release-channel';

beforeEach(() => {
  appMock.isPackaged = true;
  appMock.getVersion.mockReturnValue('0.0.20-canary.1');
});

afterEach(() => {
  delete process.env['KIMI_DESKTOP_CANARY'];
});

describe('release-channel helpers', () => {
  it('isolates packaged Windows Canary identity from stable and Preview', () => {
    expect(windowsAppId(true, '1.0.5-canary.108')).toBe('com.kimi.code.desktop.canary');
    expect(windowsAppId(true, '1.0.5')).toBe('com.kimi.code.desktop');
    expect(windowsAppId(true, '1.0.5-preview.1')).toBe('com.kimi.code.desktop.preview');
    expect(windowsAppId(false, '1.0.5-canary.108')).not.toBe('com.kimi.code.desktop.canary');
  });
  it('detects canary versions and channel enablement', () => {
    expect(isCanaryVersion('0.0.17-canary.42')).toBe(true);
    expect(isCanaryVersion('0.0.17')).toBe(false);
    expect(isCanaryChannelEnabled('0.0.17', false)).toBe(true);
    expect(isCanaryChannelEnabled('0.0.17', true)).toBe(false);
    expect(isCanaryChannelEnabled('0.0.17-canary.42', true)).toBe(true);
  });

  it('dev override simulates canary display identity without packaging', () => {
    expect(isDevCanaryOverride(false)).toBe(false);
    expect(isCanaryDisplay('0.0.17', false)).toBe(false);
    process.env['KIMI_DESKTOP_CANARY'] = 'true';
    expect(isDevCanaryOverride(false)).toBe(true);
    expect(isCanaryDisplay('0.0.17', false)).toBe(true);
    expect(isDevCanaryOverride(true)).toBe(false);
    expect(isCanaryDisplay('0.0.17', true)).toBe(false);
    expect(isCanaryDisplay('0.0.17-canary.42', true)).toBe(true);
  });
});

describe('getCanaryInfo', () => {
  it('reports channel flags for a packaged canary build', async () => {
    await expect(getCanaryInfo()).resolves.toEqual({
      enabled: true,
      isCanaryBuild: true,
      isRealCanaryBuild: true,
    });
  });
  it('reports disabled for a packaged stable build', async () => {
    appMock.getVersion.mockReturnValue('1.0.5');
    await expect(getCanaryInfo()).resolves.toEqual({
      enabled: false,
      isCanaryBuild: false,
      isRealCanaryBuild: false,
    });
  });
});
