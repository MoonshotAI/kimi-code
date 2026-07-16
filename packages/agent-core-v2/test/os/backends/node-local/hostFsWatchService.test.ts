/**
 * `hostFsWatch` domain (L1) — integration test against the real `chokidar`
 * watcher on a temporary directory.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HostFsWatchService } from '#/os/backends/node-local/hostFsWatchService';
import type { HostFsChange, IHostFsWatchHandle } from '#/os/interface/hostFsWatch';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('HostFsWatchService', () => {
  let root: string;
  let handle: IHostFsWatchHandle | undefined;

  afterEach(async () => {
    handle?.dispose();
    handle = undefined;
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function start(recursive = true): Promise<HostFsChange[]> {
    const events: HostFsChange[] = [];
    const svc = new HostFsWatchService();
    handle = svc.watch(root, { recursive });
    handle.onDidChange((e) => events.push(e));
    await wait(200);
    return events;
  }

  it('reports create / modify / delete for a file', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const events = await start();

    const file = join(root, 'a.txt');
    await writeFile(file, 'v1');
    await wait(300);
    await writeFile(file, 'v2');
    await wait(300);
    await rm(file);
    await wait(300);

    const actions = events.filter((e) => e.path === file).map((e) => e.action);
    expect(actions).toContain('created');
    expect(actions).toContain('modified');
    expect(actions).toContain('deleted');
    expect(events.find((e) => e.path === file)?.kind).toBe('file');
  });

  it('does not fire for paths ignored by default (.git)', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const events = await start();

    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), 'x');
    await wait(300);

    expect(events.some((e) => e.path.includes('/.git/') || e.path.endsWith('/.git'))).toBe(false);
  });

  it('does not fire for pre-existing files (ignoreInitial)', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const preexisting = join(root, 'pre.txt');
    await writeFile(preexisting, 'v0');

    const events = await start();
    await wait(300);

    expect(events.some((e) => e.path === preexisting)).toBe(false);
  });

  it('stops firing after the handle is disposed', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const events = await start();

    handle?.dispose();
    handle = undefined;

    await writeFile(join(root, 'after-dispose.txt'), 'x');
    await wait(300);

    expect(events).toHaveLength(0);
  });

  it('reports creation inside a nested subdirectory', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const events = await start();

    await mkdir(join(root, 'sub', 'deep'), { recursive: true });
    await writeFile(join(root, 'sub', 'deep', 'nested.txt'), 'content');
    await wait(300);

    expect(events.some((e) => e.action === 'created' && e.path.endsWith('nested.txt'))).toBe(true);
    expect(events.some((e) => e.path.includes('/sub/'))).toBe(true);
  });

  it('does not report events in non-recursive mode outside the root', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const events = await start(false);

    await mkdir(join(root, 'subdir'));
    await writeFile(join(root, 'subdir', 'hidden.txt'), 'x');
    await wait(300);

    expect(events.some((e) => e.path.endsWith('hidden.txt'))).toBe(false);
  });

  it('handles rapid successive file modifications without losing events', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const events = await start();

    const file = join(root, 'rapid.txt');
    for (let i = 0; i < 10; i++) {
      await writeFile(file, `v${i}`);
    }
    await wait(500);

    const fileEvents = events.filter((e) => e.path === file);
    expect(fileEvents.length).toBeGreaterThanOrEqual(1);
    expect(fileEvents.some((e) => e.action === 'created')).toBe(true);
    expect(fileEvents.some((e) => e.action === 'modified')).toBe(true);
  });

  it('reports a file creation when the root already contains a subdirectory', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    await mkdir(join(root, 'existing-dir'));

    const events = await start();
    await writeFile(join(root, 'existing-dir', 'new.txt'), 'data');
    await wait(300);

    expect(events.some((e) => e.action === 'created' && e.path.endsWith('new.txt'))).toBe(true);
  });

  it('exposes the watch service contract without crashing for an empty root', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-'));
    const svc = new HostFsWatchService();
    handle = svc.watch(root, { recursive: true });
    expect(handle).toBeDefined();
    expect(typeof handle.dispose).toBe('function');
    expect(typeof handle.onDidChange).toBe('function');
    await wait(200);
  });
});
