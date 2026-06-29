import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appRoot,
  executableName,
  nativeIntermediatesDir,
  nativeBinDir,
  nativeBinPath,
  nativeBlobPath,
  nativeJsBundlePath,
  nativeManifestKey,
  nativeSeaConfigPath,
  targetTriple,
  nativeDistRoot,
  nativeManifestDir,
  nativeArtifactsDir,
  nativeSmokeHome,
  SEA_SENTINEL_FUSE,
} from '../../../scripts/native/paths.mjs';

// paths.mjs builds every path with node:path.resolve (backslashes on Windows).
// Build expectations the same way so they match on every platform.
const p = (...segments: string[]): string => resolve(appRoot, ...segments);

describe('targetTriple', () => {
  it('returns platform-arch when env unset', () => {
    expect(targetTriple({ platform: 'darwin', arch: 'arm64', env: {} })).toBe('darwin-arm64');
    expect(targetTriple({ platform: 'linux', arch: 'x64', env: {} })).toBe('linux-x64');
    expect(targetTriple({ platform: 'win32', arch: 'x64', env: {} })).toBe('win32-x64');
  });

  it('honors KIMI_CODE_BUILD_TARGET override', () => {
    expect(
      targetTriple({
        platform: 'darwin',
        arch: 'arm64',
        env: { KIMI_CODE_BUILD_TARGET: 'linux-arm64' },
      }),
    ).toBe('linux-arm64');
  });
});

describe('executableName', () => {
  it('returns kimi.exe on win32', () => {
    expect(executableName('win32')).toBe('kimi.exe');
  });

  it('returns kimi on other platforms', () => {
    expect(executableName('darwin')).toBe('kimi');
    expect(executableName('linux')).toBe('kimi');
  });
});

describe('path helpers', () => {
  it('returns absolute intermediates dir under app root', () => {
    expect(nativeIntermediatesDir()).toBe(p('dist-native/intermediates'));
  });

  it('returns absolute bin dir per target', () => {
    expect(nativeBinDir('darwin-arm64')).toBe(p('dist-native/bin/darwin-arm64'));
  });

  it('returns absolute bin path with executable name', () => {
    expect(nativeBinPath('darwin-arm64', 'darwin')).toBe(
      p('dist-native/bin/darwin-arm64/kimi'),
    );
    expect(nativeBinPath('win32-x64', 'win32')).toBe(
      p('dist-native/bin/win32-x64/kimi.exe'),
    );
  });

  it('returns intermediate artifact paths', () => {
    expect(nativeJsBundlePath()).toBe(p('dist-native/intermediates/main.cjs'));
    expect(nativeBlobPath()).toBe(p('dist-native/intermediates/kimi.blob'));
    expect(nativeSeaConfigPath()).toBe(
      p('dist-native/intermediates/sea-config.json'),
    );
  });

  it('returns manifest key for target', () => {
    expect(nativeManifestKey('darwin-arm64')).toBe('native/darwin-arm64/manifest.json');
  });

  it('returns native dist root', () => {
    expect(nativeDistRoot()).toBe(p('dist-native'));
  });

  it('returns manifest dir for target', () => {
    expect(nativeManifestDir('darwin-arm64')).toBe(
      p('dist-native/intermediates/native-assets/darwin-arm64'),
    );
  });

  it('returns artifacts dir', () => {
    expect(nativeArtifactsDir()).toBe(p('dist-native/artifacts'));
  });

  it('returns smoke home', () => {
    expect(nativeSmokeHome()).toBe(p('dist-native/smoke-home'));
  });

  it('has correct SEA sentinel fuse value', () => {
    expect(SEA_SENTINEL_FUSE).toBe('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
  });
});
