import { describe, expect, it } from 'vitest';

import { buildAzureSignCommand, buildCodesignArgs } from '../../../scripts/native/04-sign.mjs';

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

describe('buildAzureSignCommand', () => {
  it('composes Invoke-TrustedSigning with endpoint, profile, account and file', () => {
    const command = buildAzureSignCommand({
      endpoint: 'https://eus.codesigning.azure.net',
      accountName: 'test-account',
      profileName: 'test-profile',
      executable: 'C:\\out\\kimi.exe',
    });
    expect(command).toBe(
      "Invoke-TrustedSigning -Endpoint 'https://eus.codesigning.azure.net' -CertificateProfileName 'test-profile' " +
        "-CodeSigningAccountName 'test-account' -TimestampRfc3161 'http://timestamp.acs.microsoft.com' " +
        "-TimestampDigest 'SHA256' -FileDigest 'SHA256' -Files 'C:\\out\\kimi.exe'",
    );
  });
});
