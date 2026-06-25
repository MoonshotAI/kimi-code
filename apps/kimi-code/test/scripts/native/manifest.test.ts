import { describe, expect, it } from 'vitest';

import {
  NATIVE_ASSET_MANIFEST_VERSION,
  buildManifestKey,
  isManifestVersionSupported,
} from '../../../src/native/manifest-keys';

describe('NATIVE_ASSET_MANIFEST_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(NATIVE_ASSET_MANIFEST_VERSION)).toBe(true);
    expect(NATIVE_ASSET_MANIFEST_VERSION).toBeGreaterThan(0);
  });
});

describe('buildManifestKey', () => {
  it('namespaces by target', () => {
    expect(buildManifestKey('darwin-arm64')).toBe('native/darwin-arm64/manifest.json');
    expect(buildManifestKey('linux-x64')).toBe('native/linux-x64/manifest.json');
  });
});

describe('isManifestVersionSupported', () => {
  it('accepts current version', () => {
    expect(isManifestVersionSupported(NATIVE_ASSET_MANIFEST_VERSION)).toBe(true);
  });

  it('rejects other versions', () => {
    expect(isManifestVersionSupported(NATIVE_ASSET_MANIFEST_VERSION + 1)).toBe(false);
    expect(isManifestVersionSupported(0)).toBe(false);
  });
});
