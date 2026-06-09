import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectFdPath, getFdAssetName } from '#/utils/process/fd-detect';
import { getBinDir } from '#/utils/paths';

const originalEnv = { ...process.env };
let tempHome: string | undefined;

afterEach(() => {
  if (tempHome !== undefined) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

describe('getFdAssetName', () => {
  it('returns the macOS arm64 asset name', () => {
    expect(getFdAssetName('darwin', 'arm64')).toBe('fd-v10.4.2-aarch64-apple-darwin.tar.gz');
  });

  it('returns the macOS x64 asset name pinned to the available upstream release', () => {
    expect(getFdAssetName('darwin', 'x64')).toBe('fd-v10.3.0-x86_64-apple-darwin.tar.gz');
  });

  it('returns the Linux x64 musl asset name', () => {
    expect(getFdAssetName('linux', 'x64')).toBe('fd-v10.4.2-x86_64-unknown-linux-musl.tar.gz');
  });

  it('returns the Windows x64 asset name', () => {
    expect(getFdAssetName('win32', 'x64')).toBe('fd-v10.4.2-x86_64-pc-windows-msvc.zip');
  });

  it('returns null for unsupported platforms or architectures', () => {
    expect(getFdAssetName('freebsd', 'x64')).toBeNull();
    expect(getFdAssetName('darwin', 'arm')).toBeNull();
  });
});

describe('detectFdPath', () => {
  it('prefers the managed fd binary under KIMI_CODE_HOME', () => {
    tempHome = mkdtempSync(join(tmpdir(), 'kimi-fd-home-'));
    process.env['KIMI_CODE_HOME'] = tempHome;
    mkdirSync(getBinDir(), { recursive: true });

    const binaryPath = join(getBinDir(), process.platform === 'win32' ? 'fd.exe' : 'fd');
    if (process.platform === 'win32') {
      // Creating a real Windows PE executable in a unit test is not practical;
      // the asset-name tests still cover Windows selection logic.
      return;
    }

    writeFileSync(binaryPath, '#!/bin/sh\necho fd 10.4.2\n');
    chmodSync(binaryPath, 0o755);

    expect(detectFdPath()).toBe(binaryPath);
  });
});
