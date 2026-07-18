/**
 * Tests for atomicWrite — specifically symlink preservation.
 *
 * The core invariant: when followSymlinks is true and `filePath` is a
 * symlink, atomicWrite should preserve the symlink (write to the resolved
 * target), not replace it. Default behavior (followSymlinks false) replaces
 * the symlink itself.
 */

import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { atomicWrite } from '../../src/utils/fs';

let rootDir: string;

beforeEach(async () => {
  rootDir = join(
    tmpdir(),
    `kimi-atomic-write-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(rootDir, { recursive: true });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('atomicWrite', () => {
  it('writes content to a regular file', async () => {
    const filePath = join(rootDir, 'regular.txt');
    await atomicWrite(filePath, 'hello world');

    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('hello world');
  });

  it('overwrites existing regular file', async () => {
    const filePath = join(rootDir, 'existing.txt');
    await writeFile(filePath, 'old content');

    await atomicWrite(filePath, 'new content');

    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('new content');
  });

  it('default behavior: replaces symlink with regular file', async () => {
    const targetDir = join(rootDir, 'target');
    await mkdir(targetDir);
    const realFile = join(targetDir, 'config.toml');
    await writeFile(realFile, 'original');

    const symlinkPath = join(rootDir, 'config.toml');
    await symlink(realFile, symlinkPath);

    // Without followSymlinks, symlink is replaced
    await atomicWrite(symlinkPath, 'new content');

    const stat = await lstat(symlinkPath);
    expect(stat.isSymbolicLink()).toBe(false);

    const content = await readFile(symlinkPath, 'utf-8');
    expect(content).toBe('new content');

    // Original target unchanged
    const originalContent = await readFile(realFile, 'utf-8');
    expect(originalContent).toBe('original');
  });

  it('followSymlinks: preserves symlink and writes to target', async () => {
    const targetDir = join(rootDir, 'real-target');
    await mkdir(targetDir);
    const realFile = join(targetDir, 'config.toml');
    await writeFile(realFile, 'original content');

    const symlinkPath = join(rootDir, 'config.toml');
    await symlink(realFile, symlinkPath);

    // Verify symlink exists
    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);

    // Write with followSymlinks
    await atomicWrite(symlinkPath, 'updated content', { followSymlinks: true });

    // Symlink should still exist
    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);

    // Real file should have new content
    expect(await readFile(realFile, 'utf-8')).toBe('updated content');

    // Reading via symlink should also show new content
    expect(await readFile(symlinkPath, 'utf-8')).toBe('updated content');
  });

  it('followSymlinks: replaces broken symlink when target does not exist', async () => {
    const targetDir = join(rootDir, 'target-dir');
    await mkdir(targetDir);
    const realFile = join(targetDir, 'new-file.toml');
    const symlinkPath = join(rootDir, 'link.toml');
    await symlink(realFile, symlinkPath);

    // Verify it's a broken symlink
    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);

    // realpath fails on broken symlink, falls back to original path
    await atomicWrite(symlinkPath, 'new content', { followSymlinks: true });

    // Symlink is replaced by regular file (fallback behavior)
    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(false);

    expect(await readFile(symlinkPath, 'utf-8')).toBe('new content');
  });

  it('handles non-existent file (no symlink)', async () => {
    const filePath = join(rootDir, 'new-file.txt');
    await atomicWrite(filePath, 'brand new');

    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('brand new');
  });

  it('followSymlinks: preserves symlink through multiple writes', async () => {
    const targetDir = join(rootDir, 'target');
    await mkdir(targetDir);
    const realFile = join(targetDir, 'config.toml');
    await writeFile(realFile, 'v1');

    const symlinkPath = join(rootDir, 'config.toml');
    await symlink(realFile, symlinkPath);

    await atomicWrite(symlinkPath, 'v2', { followSymlinks: true });
    await atomicWrite(symlinkPath, 'v3', { followSymlinks: true });
    await atomicWrite(symlinkPath, 'v4', { followSymlinks: true });

    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(realFile, 'utf-8')).toBe('v4');
  });

  it('followSymlinks: handles circular symlink gracefully', async () => {
    // Create circular symlinks: a -> b -> a
    const linkA = join(rootDir, 'link-a.toml');
    const linkB = join(rootDir, 'link-b.toml');
    await symlink(linkB, linkA);
    await symlink(linkA, linkB);

    // realpath should fail on circular symlink, fall back to original path
    await expect(
      atomicWrite(linkA, 'content', { followSymlinks: true }),
    ).resolves.not.toThrow();

    // Fallback: symlink is replaced by regular file
    expect((await lstat(linkA)).isSymbolicLink()).toBe(false);
    expect(await readFile(linkA, 'utf-8')).toBe('content');
  });
});
