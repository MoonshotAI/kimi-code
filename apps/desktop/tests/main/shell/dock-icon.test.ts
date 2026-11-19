import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { dockIconPath, initDockIcon, isDockIconChoice } from '../../../src/main/shell/dock-icon';

describe('dockIconPath', () => {
  it('uses the light tile in light mode', () => {
    expect(
      dockIconPath({ isPackaged: false, resourcesPath: '/res', appPath: '/repo', isDark: false }),
    ).toBe(join('/repo', 'build', 'icon.png'));
  });

  it('uses the dark tile in dark mode', () => {
    expect(
      dockIconPath({ isPackaged: false, resourcesPath: '/res', appPath: '/repo', isDark: true }),
    ).toBe(join('/repo', 'build', 'icon-dark.png'));
  });

  it('resolves under resourcesPath (extraResources) when packaged', () => {
    expect(
      dockIconPath({ isPackaged: true, resourcesPath: '/res', appPath: '/repo', isDark: true }),
    ).toBe(join('/res', 'build', 'icon-dark.png'));
  });
});

describe('isDockIconChoice', () => {
  it('accepts the two settings values', () => {
    expect(isDockIconChoice('light')).toBe(true);
    expect(isDockIconChoice('dark')).toBe(true);
  });

  it('rejects anything else, including the retired auto', () => {
    expect(isDockIconChoice('auto')).toBe(false);
    expect(isDockIconChoice('system')).toBe(false);
    expect(isDockIconChoice('')).toBe(false);
    expect(isDockIconChoice(1)).toBe(false);
    expect(isDockIconChoice(null)).toBe(false);
  });
});

describe('initDockIcon', () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  it('is a no-op off macOS (never touches app.dock)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(() => initDockIcon()).not.toThrow();
  });
});
