/**
 * Tests for low-level fs utilities: atomicWrite, writeFileAtomicDurable.
 */

import { lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { atomicWrite, writeFileAtomicDurable } from '../../src/utils/fs';

let rootDir: string;

beforeEach(async () => {
  rootDir = join(
    tmpdir(),
    `kimi-fs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(rootDir, { recursive: true });
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('atomicWrite', () => {
  it('writes content to a new file', async () => {
    const path = join(rootDir, 'new-file.txt');
    await atomicWrite(path, 'hello world');
    expect(await readFile(path, 'utf-8')).toBe('hello world');
  });

  it('overwrites an existing file', async () => {
    const path = join(rootDir, 'existing.txt');
    await writeFile(path, 'old', 'utf-8');
    await atomicWrite(path, 'new');
    expect(await readFile(path, 'utf-8')).toBe('new');
  });

  it('preserves symlinks and updates the target', async () => {
    const target = join(rootDir, 'real-config.toml');
    const link = join(rootDir, 'config.toml');

    await writeFile(target, 'old-value', 'utf-8');
    await symlink(target, link);

    await atomicWrite(link, 'new-value');

    // Symlink must still be a symlink
    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);

    // Target must have new content
    expect(await readFile(target, 'utf-8')).toBe('new-value');

    // Reading through symlink must also give new content
    expect(await readFile(link, 'utf-8')).toBe('new-value');
  });

  it('preserves relative symlinks', async () => {
    const subdir = join(rootDir, 'sub');
    await mkdir(subdir, { recursive: true });
    const target = join(subdir, 'target.json');
    const link = join(rootDir, 'link.json');

    await writeFile(target, '{"old":true}', 'utf-8');
    await symlink('sub/target.json', link);

    await atomicWrite(link, '{"new":true}');

    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf-8')).toBe('{"new":true}');
  });
});

describe('writeFileAtomicDurable', () => {
  it('writes content to a new file', async () => {
    const path = join(rootDir, 'durable.txt');
    await writeFileAtomicDurable(path, 'durable content');
    expect(await readFile(path, 'utf-8')).toBe('durable content');
  });

  it('preserves symlinks and updates the target', async () => {
    const target = join(rootDir, 'real-data.json');
    const link = join(rootDir, 'data.json');

    await writeFile(target, '{"old":1}', 'utf-8');
    await symlink(target, link);

    await writeFileAtomicDurable(link, '{"new":2}');

    const stats = await lstat(link);
    expect(stats.isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf-8')).toBe('{"new":2}');
  });
});
