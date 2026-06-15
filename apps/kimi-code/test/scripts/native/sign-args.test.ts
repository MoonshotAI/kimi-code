import { describe, expect, it } from 'vitest';

import {
  buildCodesignArgs,
  buildCodesignNativeHelperArgs,
} from '../../../scripts/native/04-sign.mjs';

describe('buildCodesignArgs', () => {
  it('returns ad-hoc args for identity "-"', () => {
    const args = buildCodesignArgs({
      identity: '-',
      executable: '/path/kimi',
      entitlementsPath: '/path/entitlements.plist',
      keychainPath: null,
    });
    expect(args).toEqual(['--sign', '-', '/path/kimi']);
  });

  it('returns hardened-runtime args for Developer ID identity', () => {
    const args = buildCodesignArgs({
      identity: 'Developer ID Application: Moonshot AI (ABCD1234)',
      executable: '/path/kimi',
      entitlementsPath: '/path/entitlements.plist',
      keychainPath: '/tmp/sign.keychain-db',
    });
    expect(args).toEqual([
      '--sign',
      'Developer ID Application: Moonshot AI (ABCD1234)',
      '--options',
      'runtime',
      '--entitlements',
      '/path/entitlements.plist',
      '--timestamp',
      '--keychain',
      '/tmp/sign.keychain-db',
      '--force',
      '/path/kimi',
    ]);
  });

  it('omits --keychain when keychainPath is null but uses Developer ID otherwise', () => {
    const args = buildCodesignArgs({
      identity: 'Developer ID Application: Moonshot AI (ABCD1234)',
      executable: '/path/kimi',
      entitlementsPath: '/path/entitlements.plist',
      keychainPath: null,
    });
    expect(args).toContain('--entitlements');
    expect(args).not.toContain('--keychain');
  });
});

describe('buildCodesignNativeHelperArgs', () => {
  it('returns ad-hoc args for identity "-"', () => {
    expect(
      buildCodesignNativeHelperArgs({
        identity: '-',
        file: '/path/native/helper.node',
        keychainPath: null,
      }),
    ).toEqual(['--sign', '-', '/path/native/helper.node']);
  });

  it('returns hardened-runtime args without app entitlements for Developer ID identity', () => {
    expect(
      buildCodesignNativeHelperArgs({
        identity: 'Developer ID Application: Moonshot AI (ABCD1234)',
        file: '/path/native/helper.node',
        keychainPath: '/tmp/sign.keychain-db',
      }),
    ).toEqual([
      '--sign',
      'Developer ID Application: Moonshot AI (ABCD1234)',
      '--options',
      'runtime',
      '--timestamp',
      '--keychain',
      '/tmp/sign.keychain-db',
      '--force',
      '/path/native/helper.node',
    ]);
  });
});
