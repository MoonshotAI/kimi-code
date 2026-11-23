import { describe, expect, it } from 'vitest';

import { directoryOpenAppId } from '../../src/renderer/lib/nativeOpenIn';

describe('directoryOpenAppId', () => {
  it.each([
    ['darwin', 'finder'],
    ['win32', 'explorer'],
    ['linux', 'file-manager'],
  ])('maps %s to the native directory opener', (platform, appId) => {
    expect(directoryOpenAppId(platform)).toBe(appId);
  });

  it('returns null for unsupported platforms', () => {
    expect(directoryOpenAppId('freebsd')).toBeNull();
    expect(directoryOpenAppId('')).toBeNull();
  });
});
