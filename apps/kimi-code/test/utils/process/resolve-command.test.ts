import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveCommandPath } from '#/utils/process/resolve-command';

const originalEnv = { ...process.env };
const originalPlatform = process.platform;
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  process.env = { ...originalEnv };
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function mockPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

describe('resolveCommandPath (posix)', () => {
  // Executable-bit checks only work on a posix host.
  it.skipIf(process.platform === 'win32')('resolves an executable from PATH to an absolute path', () => {
    const bin = makeTempDir('kimi-resolve-bin-');
    const cwd = makeTempDir('kimi-resolve-cwd-');
    const tool = join(bin, 'mytool');
    writeFileSync(tool, '#!/bin/sh\nexit 0\n');
    chmodSync(tool, 0o755);
    process.env['PATH'] = bin;

    expect(resolveCommandPath('mytool', cwd)).toBe(tool);
  });

  it.skipIf(process.platform === 'win32')('ignores PATH files without the executable bit', () => {
    const bin = makeTempDir('kimi-resolve-bin-');
    const cwd = makeTempDir('kimi-resolve-cwd-');
    writeFileSync(join(bin, 'mytool'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'mytool'), 0o644);
    process.env['PATH'] = bin;

    expect(resolveCommandPath('mytool', cwd)).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('refuses a hit inside the current working directory', () => {
    const cwd = makeTempDir('kimi-resolve-cwd-');
    const tool = join(cwd, 'mytool');
    writeFileSync(tool, '#!/bin/sh\nexit 0\n');
    chmodSync(tool, 0o755);
    // The cwd itself sits on PATH (e.g. a `.` entry) — the planted binary
    // must be rejected, not executed.
    process.env['PATH'] = cwd;

    expect(resolveCommandPath('mytool', cwd)).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('refuses a hit from a relative PATH entry landing in the cwd', () => {
    const cwd = makeTempDir('kimi-resolve-cwd-');
    const tool = join(cwd, 'mytool');
    writeFileSync(tool, '#!/bin/sh\nexit 0\n');
    chmodSync(tool, 0o755);
    process.env['PATH'] = '.';

    expect(resolveCommandPath('mytool', cwd)).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('refuses a hit in a subdirectory of the cwd', () => {
    const cwd = makeTempDir('kimi-resolve-cwd-');
    const nested = join(cwd, 'bin');
    mkdirSync(nested);
    const tool = join(nested, 'mytool');
    writeFileSync(tool, '#!/bin/sh\nexit 0\n');
    chmodSync(tool, 0o755);
    process.env['PATH'] = nested;

    expect(resolveCommandPath('mytool', cwd)).toBeUndefined();
  });

  it('returns undefined when the command is not on PATH', () => {
    const bin = makeTempDir('kimi-resolve-bin-');
    const cwd = makeTempDir('kimi-resolve-cwd-');
    process.env['PATH'] = bin;

    expect(resolveCommandPath('definitely-not-a-real-command', cwd)).toBeUndefined();
  });
});

describe('resolveCommandPath (win32)', () => {
  it('resolves a bare name through PATHEXT', () => {
    mockPlatform('win32');
    const bin = makeTempDir('kimi-resolve-bin-');
    const cwd = makeTempDir('kimi-resolve-cwd-');
    // Windows is case-insensitive, so the resolved name carries the PATHEXT
    // casing; match it here so the test also passes on case-insensitive
    // posix filesystems.
    const shim = join(bin, 'npm.CMD');
    writeFileSync(shim, '@echo off\r\n');
    process.env['PATH'] = bin;
    process.env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD';

    expect(resolveCommandPath('npm', cwd)).toBe(shim);
  });

  it('tries an explicitly suffixed name as-is', () => {
    mockPlatform('win32');
    const bin = makeTempDir('kimi-resolve-bin-');
    const cwd = makeTempDir('kimi-resolve-cwd-');
    const shim = join(bin, 'npm.cmd');
    writeFileSync(shim, '@echo off\r\n');
    process.env['PATH'] = bin;
    process.env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD';

    expect(resolveCommandPath('npm.cmd', cwd)).toBe(shim);
  });

  it('falls back to the default PATHEXT when the variable is unset', () => {
    mockPlatform('win32');
    const bin = makeTempDir('kimi-resolve-bin-');
    const cwd = makeTempDir('kimi-resolve-cwd-');
    const shim = join(bin, 'bun.EXE');
    writeFileSync(shim, 'MZ');
    process.env['PATH'] = bin;
    delete process.env['PATHEXT'];

    expect(resolveCommandPath('bun', cwd)).toBe(shim);
  });

  it('refuses a hit inside the current working directory', () => {
    mockPlatform('win32');
    const cwd = makeTempDir('kimi-resolve-cwd-');
    writeFileSync(join(cwd, 'npm.cmd'), '@echo off\r\n');
    process.env['PATH'] = cwd;
    process.env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD';

    expect(resolveCommandPath('npm', cwd)).toBeUndefined();
  });
});
