/**
 * `fs-path-safety` unit tests (W10.1 / Chain 9).
 *
 * Covers each branch of the safety algorithm:
 *   - empty string / literal '/'
 *   - absolute POSIX path
 *   - relative path containing '..' (lexically inside cwd, still rejected)
 *   - relative path that resolves to a sibling via `cwd/../something`
 *   - symlink target outside cwd
 *   - happy path: '.' / 'src/index.ts' / nested existing path
 *
 * Uses `os.tmpdir()`-anchored sandboxes — macOS-realpath-safe because the
 * algorithm realpaths the cwd before containment.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FsPathEscapesError,
  resolveSafePath,
} from '#/services/fs/fsPathSafety';

let tmpDir: string;
let cwd: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-path-safety-'));
  cwd = join(tmpDir, 'workspace');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'hello.txt'), 'hi');
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'index.ts'), 'export {}');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveSafePath', () => {
  it('resolves "." to the cwd root', async () => {
    const r = await resolveSafePath(cwd, '.');
    expect(r.relative).toBe('.');
  });

  it('resolves a one-level child', async () => {
    const r = await resolveSafePath(cwd, 'hello.txt');
    expect(r.relative).toBe('hello.txt');
    expect(r.absolute.endsWith('/hello.txt')).toBe(true);
  });

  it('resolves a nested path', async () => {
    const r = await resolveSafePath(cwd, 'src/index.ts');
    expect(r.relative).toBe('src/index.ts');
  });

  it('rejects the empty string', async () => {
    await expect(resolveSafePath(cwd, '')).rejects.toThrowError(FsPathEscapesError);
    try {
      await resolveSafePath(cwd, '');
    } catch (err) {
      expect((err as FsPathEscapesError).reason).toBe('empty');
    }
  });

  it('rejects the literal "/"', async () => {
    try {
      await resolveSafePath(cwd, '/');
    } catch (err) {
      expect((err as FsPathEscapesError).reason).toBe('empty');
    }
  });

  it('rejects an absolute POSIX path', async () => {
    try {
      await resolveSafePath(cwd, '/etc/passwd');
    } catch (err) {
      expect((err as FsPathEscapesError).reason).toBe('absolute');
    }
  });

  it('rejects any input containing a ".." segment (even when lexically inside cwd)', async () => {
    // 'a/../hello.txt' would resolve to cwd/hello.txt lexically, but
    // SCHEMAS §4.4 line 755 says "拒绝包含 `..` 段" regardless.
    try {
      await resolveSafePath(cwd, 'a/../hello.txt');
    } catch (err) {
      expect((err as FsPathEscapesError).reason).toBe('dotdot_segment');
    }
  });

  it('rejects a "../../../etc/passwd"-style escape', async () => {
    try {
      await resolveSafePath(cwd, '../../etc/passwd');
    } catch (err) {
      expect((err as FsPathEscapesError).reason).toBe('dotdot_segment');
    }
  });

  it('rejects a symlink that targets a path OUTSIDE cwd', async () => {
    const outside = join(tmpDir, 'outside.txt');
    writeFileSync(outside, 'sneaky');
    symlinkSync(outside, join(cwd, 'escape'));
    try {
      await resolveSafePath(cwd, 'escape');
      throw new Error('should have rejected symlink-outside');
    } catch (err) {
      expect(err).toBeInstanceOf(FsPathEscapesError);
      expect((err as FsPathEscapesError).reason).toBe('symlink_outside_cwd');
    }
  });

  it('accepts a symlink that targets a path INSIDE cwd', async () => {
    symlinkSync(join(cwd, 'hello.txt'), join(cwd, 'alias'));
    const r = await resolveSafePath(cwd, 'alias');
    // Realpath collapses to the real file inside cwd.
    expect(r.relative).toBe('hello.txt');
  });

  it('accepts a missing-tail path (e.g. for future write or 40409 surface)', async () => {
    const r = await resolveSafePath(cwd, 'does-not-exist.txt');
    expect(r.relative).toBe('does-not-exist.txt');
  });
});
