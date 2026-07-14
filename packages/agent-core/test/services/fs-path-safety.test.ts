import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FsPathEscapesError,
  resolveSafePath,
  isTempPath,
  resolveTempPath,
} from '@moonshot-ai/agent-core';

describe('isTempPath', () => {
  it('returns true for /tmp paths', () => {
    expect(isTempPath('/tmp')).toBe(true);
    expect(isTempPath('/tmp/')).toBe(true);
    expect(isTempPath('/tmp/foo')).toBe(true);
    expect(isTempPath('/tmp/foo/bar')).toBe(true);
  });

  it('returns true for /var/tmp paths', () => {
    expect(isTempPath('/var/tmp')).toBe(true);
    expect(isTempPath('/var/tmp/file.txt')).toBe(true);
  });

  it('returns true for /dev/shm paths', () => {
    expect(isTempPath('/dev/shm')).toBe(true);
    expect(isTempPath('/dev/shm/shared')).toBe(true);
  });

  it('returns true for os.tmpdir() paths', () => {
    const t = tmpdir();
    expect(isTempPath(t)).toBe(true);
    expect(isTempPath(join(t, 'sub'))).toBe(true);
  });

  it('returns false for non-temp paths', () => {
    expect(isTempPath('/')).toBe(false);
    expect(isTempPath('/home')).toBe(false);
    expect(isTempPath('/usr/local')).toBe(false);
    expect(isTempPath('/tmpfoo')).toBe(false);
    expect(isTempPath('/var/tmpfoo')).toBe(false);
  });
});

describe('resolveTempPath', () => {
  it('resolves a simple temp file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fs-temp-'));
    const file = join(dir, 'test.txt');
    writeFileSync(file, 'hello');
    const result = await resolveTempPath(file);
    expect(result.absolute).toBe(file);
    expect(result.relative).toBe(file);
    rmSync(dir, { recursive: true });
  });

  it('rejects empty path', async () => {
    await expect(resolveTempPath('')).rejects.toBeInstanceOf(FsPathEscapesError);
  });

  it('rejects path with ..', async () => {
    await expect(resolveTempPath('/tmp/../etc/passwd')).rejects.toBeInstanceOf(FsPathEscapesError);
  });

  it('rejects non-temp path', async () => {
    await expect(resolveTempPath('/etc/passwd')).rejects.toBeInstanceOf(FsPathEscapesError);
  });
});

describe('resolveSafePath + temp fallback', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'fs-safe-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true });
  });

  it('resolves relative paths inside cwd', async () => {
    const result = await resolveSafePath(tempDir, 'foo.txt');
    expect(result.absolute).toBe(join(tempDir, 'foo.txt'));
    expect(result.relative).toBe('foo.txt');
  });

  it('rejects absolute paths outside cwd', async () => {
    await expect(resolveSafePath(tempDir, '/etc/passwd')).rejects.toBeInstanceOf(FsPathEscapesError);
  });

  it('resolves symlinks inside cwd', async () => {
    const target = join(tempDir, 'real.txt');
    const link = join(tempDir, 'link.txt');
    writeFileSync(target, 'hello');
    symlinkSync(target, link);
    const result = await resolveSafePath(tempDir, 'link.txt');
    expect(result.absolute).toBe(target);
    // resolveSafePath resolves symlinks to their real path for safety
    expect(result.relative).toBe('real.txt');
  });

  it('rejects symlinks outside cwd', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    const link = join(tempDir, 'escape.txt');
    symlinkSync(outside, link);
    await expect(resolveSafePath(tempDir, 'escape.txt')).rejects.toBeInstanceOf(FsPathEscapesError);
    rmSync(outside, { recursive: true });
  });
});
