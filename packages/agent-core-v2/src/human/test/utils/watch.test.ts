import { readdirSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createWatchService,
  watch,
  type WatchChange,
  type WatchHandle,
  type WatchRuntime,
} from '#/utils/watch';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class TestNativeWatcher {
  private errorListener: ((error: NodeJS.ErrnoException) => void) | undefined;
  closed = false;

  on(_event: 'error', listener: (error: NodeJS.ErrnoException) => void): this {
    this.errorListener = listener;
    return this;
  }

  close(): void {
    this.closed = true;
  }

  fail(code = 'EIO'): void {
    this.errorListener?.(Object.assign(new Error('native watch failed'), { code }));
  }
}

interface TestNativeAttempt {
  readonly watcher: TestNativeWatcher;
  emit(filename: string | null): void;
}

interface TestRetry {
  readonly delayMs: number;
  readonly active: boolean;
  run(): void;
}

function signalRig(options?: { readonly synchronousFailures?: number; readonly nativeCode?: string }): {
  readonly service: ReturnType<typeof createWatchService>;
  readonly attempts: TestNativeAttempt[];
  readonly retries: TestRetry[];
  attempt(index: number): TestNativeAttempt;
  retry(index: number): TestRetry;
} {
  const attempts: TestNativeAttempt[] = [];
  const retries: TestRetry[] = [];
  let synchronousFailures = options?.synchronousFailures ?? 0;
  const runtime: WatchRuntime = {
    platform: 'darwin',
    watchNative: (_root, listener) => {
      if (synchronousFailures > 0) {
        synchronousFailures -= 1;
        throw Object.assign(new Error('native watch creation failed'), {
          code: options?.nativeCode ?? 'EIO',
        });
      }
      const watcher = new TestNativeWatcher();
      attempts.push({
        watcher,
        emit: (filename) => {
          listener('rename', filename);
        },
      });
      return watcher;
    },
    scheduleRetry: (callback, delayMs) => {
      let active = true;
      retries.push({
        delayMs,
        get active() {
          return active;
        },
        run: () => {
          if (!active) return;
          active = false;
          callback();
        },
      });
      return {
        dispose: () => {
          active = false;
        },
      };
    },
    reportError: () => undefined,
  };
  return {
    service: createWatchService(runtime),
    attempts,
    retries,
    attempt: (index) => requiredAt(attempts, index),
    retry: (index) => requiredAt(retries, index),
  };
}

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`missing test value at index ${index}`);
  return value;
}

describe('watch signal mode', () => {
  let handle: WatchHandle | undefined;

  afterEach(() => {
    handle?.dispose();
    handle = undefined;
  });

  it('emits a coarse root invalidation when a native signal path changes', () => {
    const rig = signalRig();
    const events: WatchChange[] = [];
    handle = rig.service.watch('/repo', { signal: true });
    handle.onDidChange((event) => events.push(event));

    rig.attempt(0).emit('skills/demo/SKILL.md');

    expect(events).toEqual([{ path: '/repo', action: 'modified', kind: 'directory' }]);
  });

  it('does not invalidate when a native signal path is ignored', () => {
    const rig = signalRig();
    const events: WatchChange[] = [];
    handle = rig.service.watch('/repo', {
      signal: true,
      ignored: (path) => path.includes('node_modules'),
    });
    handle.onDidChange((event) => events.push(event));

    rig.attempt(0).emit('node_modules/pkg/index.js');

    expect(events).toEqual([]);
  });

  it('increases the retry delay after consecutive native failures', () => {
    const rig = signalRig();
    handle = rig.service.watch('/repo', { signal: true });

    rig.attempt(0).watcher.fail();
    rig.retry(0).run();
    rig.attempt(1).watcher.fail();
    rig.retry(1).run();
    rig.attempt(2).watcher.fail();

    expect(rig.retries.map((retry) => retry.delayMs)).toEqual([1000, 2000, 4000]);
  });

  it('invalidates again after a native watch is rearmed', () => {
    const rig = signalRig();
    const events: WatchChange[] = [];
    handle = rig.service.watch('/repo', { signal: true });
    handle.onDidChange((event) => events.push(event));

    rig.attempt(0).watcher.fail();
    rig.retry(0).run();

    expect(events).toEqual([
      { path: '/repo', action: 'modified', kind: 'directory' },
      { path: '/repo', action: 'modified', kind: 'directory' },
    ]);
  });

  it('invalidates after recovering from a synchronous native-watch creation failure', () => {
    const rig = signalRig({ synchronousFailures: 1 });
    const events: WatchChange[] = [];
    handle = rig.service.watch('/repo', { signal: true });
    handle.onDidChange((event) => events.push(event));

    rig.retry(0).run();

    expect(rig.attempts).toHaveLength(1);
    expect(events).toEqual([{ path: '/repo', action: 'modified', kind: 'directory' }]);
  });

  it('resets the retry delay after the recovered native watch emits an event', () => {
    const rig = signalRig();
    handle = rig.service.watch('/repo', { signal: true });

    rig.attempt(0).watcher.fail();
    rig.retry(0).run();
    rig.attempt(1).emit('skills/demo/SKILL.md');
    rig.attempt(1).watcher.fail();

    expect(rig.retries.map((retry) => retry.delayMs)).toEqual([1000, 1000]);
  });

  it('cancels a pending native retry when the watch handle is disposed', () => {
    const rig = signalRig();
    handle = rig.service.watch('/repo', { signal: true });
    rig.attempt(0).watcher.fail();

    handle.dispose();
    handle = undefined;
    rig.retry(0).run();

    expect(rig.retry(0).active).toBe(false);
    expect(rig.attempt(0).watcher.closed).toBe(true);
    expect(rig.attempts).toHaveLength(1);
  });

  it('falls back to chokidar when native recursive watch is unavailable on the platform', async () => {
    const root = await mkdtemp(join(tmpdir(), 'watch-fallback-'));
    const rig = signalRig();
    const events: WatchChange[] = [];
    try {
      handle = rig.service.watch(root, { signal: true });
      handle.onDidChange((event) => events.push(event));

      rig.attempt(0).watcher.fail('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
      await handle.ready;
      await wait(500);

      const file = join(root, 'a.txt');
      await writeFile(file, 'v1');
      await wait(300);

      expect(events[0]).toEqual({ path: root, action: 'modified', kind: 'directory' });
      expect(events.some((e) => e.path === file && e.action === 'created')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses chokidar for signal watches on platforms without native recursive watch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'watch-linux-signal-'));
    let nativeCalls = 0;
    const service = createWatchService({
      platform: 'linux',
      watchNative: () => {
        nativeCalls += 1;
        throw new Error('native watch must not be used on linux');
      },
      scheduleRetry: () => ({ dispose: () => {} }),
      reportError: () => undefined,
    });
    const events: WatchChange[] = [];
    try {
      handle = service.watch(root, { signal: true });
      handle.onDidChange((event) => events.push(event));
      await handle.ready;

      const file = join(root, 'a.txt');
      await writeFile(file, 'v1');
      await wait(300);

      expect(nativeCalls).toBe(0);
      expect(events.some((e) => e.path === file && e.action === 'created')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('watch chokidar mode', () => {
  let root: string;
  let handle: WatchHandle | undefined;

  afterEach(async () => {
    handle?.dispose();
    handle = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  async function start(options?: Parameters<typeof watch>[1]): Promise<WatchChange[]> {
    const events: WatchChange[] = [];
    handle = watch(root, options);
    handle.onDidChange((e) => events.push(e));
    await handle.ready;
    return events;
  }

  it('reports create / modify / delete for a file and skips preexisting files', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-'));
    const preexisting = join(root, 'pre.txt');
    await writeFile(preexisting, 'v0');
    const events = await start();

    const file = join(root, 'a.txt');
    const actions = () => events.filter((e) => e.path === file).map((e) => e.action);
    await writeFile(file, 'v1');
    await expect.poll(actions).toContain('created');
    await writeFile(file, 'v2');
    await expect.poll(actions).toContain('modified');
    await rm(file);
    await expect.poll(actions).toContain('deleted');

    expect(events.some((e) => e.path === preexisting)).toBe(false);
    expect(events.find((e) => e.path === file)?.kind).toBe('file');
  });

  it('does not fire for paths ignored by default (.git)', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-'));
    const events = await start();

    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), 'x');
    await wait(300);

    expect(events.some((e) => e.path.includes('/.git/') || e.path.endsWith('/.git'))).toBe(false);
  });

  it('prunes events matching a custom ignored predicate', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-'));
    const events = await start({ ignored: (path) => path.includes('node_modules') });

    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    await writeFile(join(root, 'index.ts'), 'x');
    await wait(300);

    expect(events.some((e) => e.path.includes('node_modules'))).toBe(false);
    await expect.poll(() => events.some((e) => e.path === join(root, 'index.ts'))).toBe(true);
  });

  it('does not report changes below the configured depth', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-'));
    const events = await start({ depth: 0 });

    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'top.txt'), 'x');
    await writeFile(join(root, 'sub', 'nested.txt'), 'x');
    await wait(300);

    await expect.poll(() => events.some((e) => e.path === join(root, 'top.txt'))).toBe(true);
    await expect.poll(() => events.some((e) => e.path === join(root, 'sub'))).toBe(true);
    expect(events.some((e) => e.path.endsWith('nested.txt'))).toBe(false);
  });

  it('treats recursive false as depth zero', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-'));
    const events = await start({ recursive: false });

    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'top.txt'), 'x');
    await writeFile(join(root, 'sub', 'nested.txt'), 'x');
    await wait(300);

    await expect.poll(() => events.some((e) => e.path === join(root, 'top.txt'))).toBe(true);
    expect(events.some((e) => e.path.endsWith('nested.txt'))).toBe(false);
  });

  it('stops firing after the handle is disposed', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-'));
    const events = await start();

    handle?.dispose();
    handle = undefined;

    await writeFile(join(root, 'after-dispose.txt'), 'x');
    await wait(300);

    expect(events).toHaveLength(0);
  });

  it.skipIf(process.platform !== 'darwin')(
    'signal mode keeps the fd footprint bounded on a fat subtree',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'watch-fat-'));
      const fat = join(root, 'fat');
      await mkdir(fat, { recursive: true });
      for (let i = 0; i < 1200; i++) {
        await writeFile(join(fat, `f${i}.txt`), 'x');
      }

      const fdsBefore = readdirSync('/dev/fd').length;
      await start({ recursive: true, signal: true });
      const fdsAfter = readdirSync('/dev/fd').length;

      expect(fdsAfter - fdsBefore).toBeLessThan(50);
    },
    30000,
  );
});
