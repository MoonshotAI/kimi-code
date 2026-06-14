/**
 * Tests for atomicWrite — specifically symlink preservation.
 *
 * The core invariant: if `filePath` is a symlink, atomicWrite should
 * preserve the symlink (write to the resolved target), not replace it.
 */

import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

  it('preserves symlink and writes to target', async () => {
    // Create a real file in a subdirectory (simulating iCloud target)
    const targetDir = join(rootDir, 'real-target');
    await mkdir(targetDir);
    const realFile = join(targetDir, 'config.toml');
    await writeFile(realFile, 'original content');

    // Create a symlink to the real file
    const symlinkPath = join(rootDir, 'config.toml');
    await symlink(realFile, symlinkPath);

    // Verify symlink exists and points to real file
    const symlinkStat = await stat(symlinkPath, { bigint: false });
    const lstatResult = await (await import('node:fs/promises')).lstat(symlinkPath);
    expect(lstatResult.isSymbolicLink()).toBe(true);

    // Write via atomicWrite using the symlink path
    await atomicWrite(symlinkPath, 'updated content');

    // Symlink should still exist
    const afterLstat = await (await import('node:fs/promises')).lstat(symlinkPath);
    expect(afterLstat.isSymbolicLink()).toBe(true);

    // Real file should have new content
    const realContent = await readFile(realFile, 'utf-8');
    expect(realContent).toBe('updated content');

    // Reading via symlink should also show new content
    const symlinkContent = await readFile(symlinkPath, 'utf-8');
    expect(symlinkContent).toBe('updated content');
  });

  it('replaces broken symlink when target does not exist', async () => {
    // Create symlink to non-existent file (broken symlink)
    const targetDir = join(rootDir, 'target-dir');
    await mkdir(targetDir);
    const realFile = join(targetDir, 'new-file.toml');
    const symlinkPath = join(rootDir, 'link.toml');
    await symlink(realFile, symlinkPath);

    // Verify it's a broken symlink
    const lstatBefore = await (await import('node:fs/promises')).lstat(symlinkPath);
    expect(lstatBefore.isSymbolicLink()).toBe(true);

    // realpath fails on broken symlink, falls back to original path
    // which replaces the symlink with a regular file
    await atomicWrite(symlinkPath, 'new content');

    // Symlink is replaced by regular file (fallback behavior)
    const lstatAfter = await (await import('node:fs/promises')).lstat(symlinkPath);
    expect(lstatAfter.isSymbolicLink()).toBe(false);

    // File should have content
    const content = await readFile(symlinkPath, 'utf-8');
    expect(content).toBe('new content');
  });


  it('handles non-existent file (no symlink)', async () => {
    const filePath = join(rootDir, 'new-file.txt');
    await atomicWrite(filePath, 'brand new');

    const content = await readFile(filePath, 'utf-8');
    expect(content).toBe('brand new');
  });

  it('preserves symlink through multiple writes', async () => {
    const targetDir = join(rootDir, 'target');
    await mkdir(targetDir);
    const realFile = join(targetDir, 'config.toml');
    await writeFile(realFile, 'v1');

    const symlinkPath = join(rootDir, 'config.toml');
    await symlink(realFile, symlinkPath);

    // Multiple writes
    await atomicWrite(symlinkPath, 'v2');
    await atomicWrite(symlinkPath, 'v3');
    await atomicWrite(symlinkPath, 'v4');

    // Symlink should still exist
    const lstatResult = await (await import('node:fs/promises')).lstat(symlinkPath);
    expect(lstatResult.isSymbolicLink()).toBe(true);

    // Final content
    const content = await readFile(realFile, 'utf-8');
    expect(content).toBe('v4');
  });
});
