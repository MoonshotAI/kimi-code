/**
 * `hostFsWatch` domain — integration tests against the real watcher
 * backends (chokidar, plus the native recursive watch used by `signal`
 * mode on darwin/win32) on a temporary directory.
 */

import { readdirSync } from 'node:fs';
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

  async function startSignal(ignored?: (path: string) => boolean): Promise<HostFsChange[]> {
    const events: HostFsChange[] = [];
    const svc = new HostFsWatchService();
    handle = svc.watch(root, { recursive: true, signal: true, ignored });
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

  it('signal mode reports create / modify / delete for a file', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-signal-'));
    const events = await startSignal();

    const file = join(root, 'a.txt');
    await writeFile(file, 'v1');
    await wait(500);
    await writeFile(file, 'v2');
    await wait(500);
    await rm(file);
    await wait(500);

    const actions = events.filter((e) => e.path === file).map((e) => e.action);
    expect(actions).toContain('created');
    expect(actions).toContain('modified');
    expect(actions).toContain('deleted');
  });

  it('signal mode honors the ignored predicate', async () => {
    root = await mkdtemp(join(tmpdir(), 'hostfswatch-signal-'));
    const events = await startSignal((p) => p.includes('node_modules'));

    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    await writeFile(join(root, 'visible.txt'), 'x');
    await wait(500);

    expect(events.some((e) => e.path.includes('node_modules'))).toBe(false);
    expect(events.some((e) => e.path === join(root, 'visible.txt'))).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin')(
    'signal mode keeps the fd footprint bounded on a fat subtree',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'hostfswatch-fat-'));
      const fat = join(root, 'fat');
      await mkdir(fat, { recursive: true });
      for (let i = 0; i < 1200; i++) {
        await writeFile(join(fat, `f${i}.txt`), 'x');
      }

      const fdsBefore = readdirSync('/dev/fd').length;
      await startSignal();
      const fdsAfter = readdirSync('/dev/fd').length;

      expect(fdsAfter - fdsBefore).toBeLessThan(50);
    },
    30000,
  );
});
