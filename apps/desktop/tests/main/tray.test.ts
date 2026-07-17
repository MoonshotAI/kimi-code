import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { trayIconPath } from '../../src/main/tray';

describe('trayIconPath', () => {
  it('uses the .ico asset on Windows', () => {
    expect(
      trayIconPath({ platform: 'win32', isPackaged: false, resourcesPath: '/res', appPath: '/repo' }),
    ).toBe(join('/repo', 'build', 'tray.ico'));
  });

  it('uses the monochrome template image on macOS (OS re-colors for light/dark menu bar)', () => {
    expect(
      trayIconPath({ platform: 'darwin', isPackaged: false, resourcesPath: '/res', appPath: '/repo' }),
    ).toBe(join('/repo', 'build', 'trayTemplate.png'));
  });

  it('uses the color png on Linux (retina @2x resolved by nativeImage)', () => {
    expect(
      trayIconPath({ platform: 'linux', isPackaged: false, resourcesPath: '/res', appPath: '/repo' }),
    ).toBe(join('/repo', 'build', 'tray.png'));
  });

  it('resolves under resourcesPath (extraResources) when packaged', () => {
    expect(
      trayIconPath({ platform: 'darwin', isPackaged: true, resourcesPath: '/res', appPath: '/repo' }),
    ).toBe(join('/res', 'build', 'trayTemplate.png'));
  });
});
