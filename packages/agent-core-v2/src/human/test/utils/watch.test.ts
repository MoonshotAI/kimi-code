import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWatchService,
  setWatchEnabled,
  watch,
  watchCandidates,
  type WatchChange,
  type WatchHandle,
  type WatchRuntime,
} from '#/utils/watch';

interface TestChokidarOptions {
  readonly depth?: number;
  readonly ignored?: (path: string) => boolean;
  readonly usePolling?: boolean;
}

const chokidarMockState = vi.hoisted(() => ({
  factory: undefined as ((options: TestChokidarOptions) => unknown) | undefined,
}));

vi.mock('chokidar', async (importOriginal) => {
  const original = await importOriginal<typeof import('chokidar')>();
  const FSWatcher = function (this: unknown, options?: TestChokidarOptions) {
    if (chokidarMockState.factory !== undefined) {
      return chokidarMockState.factory(options ?? {});
    }
    return new original.FSWatcher(options);
  } as unknown as typeof original.FSWatcher;
  return { ...original, FSWatcher };
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const longTempDir = (prefix: string): Promise<string> =>
  mkdtemp(join(realpathSync.native(tmpdir()), prefix));

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

class TestChokidarWatcher {
  private readonly listeners = new Map<string, Set<(...args: never[]) => void>>();
  readonly paths: string[] = [];
  closed = false;

  constructor(readonly options: TestChokidarOptions) {}

  on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  once(event: string, listener: (...args: never[]) => void): this {
    const wrapper = (...args: never[]) => {
      this.listeners.get(event)?.delete(wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  add(path: string): this {
    this.paths.push(path);
    queueMicrotask(() => {
      if (!this.closed) this.emit('ready');
    });
    return this;
  }

  close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    return Promise.resolve();
  }

  emit(event: 'ready'): void;
  emit(event: 'error', error: unknown): void;
  emit(event: 'all', eventName: string, path: string): void;
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }
}

interface TestNativeAttempt {
  readonly root: string;
  readonly recursive: boolean;
  readonly watcher: TestNativeWatcher;
  emit(filename: string | null): void;
}

interface TestRetry {
  readonly delayMs: number;
  readonly active: boolean;
  run(): void;
}

function signalRig(options?: {
  readonly synchronousFailures?: number;
  readonly nativeCode?: string;
  readonly platform?: NodeJS.Platform;
  readonly resolvePath?: (path: string) => string;
}): {
  readonly service: ReturnType<typeof createWatchService>;
  readonly attempts: TestNativeAttempt[];
  readonly retries: TestRetry[];
  readonly reportedErrors: unknown[];
  attempt(index: number): TestNativeAttempt;
  retry(index: number): TestRetry;
} {
  const attempts: TestNativeAttempt[] = [];
  const retries: TestRetry[] = [];
  const reportedErrors: unknown[] = [];
  let synchronousFailures = options?.synchronousFailures ?? 0;
  const runtime: WatchRuntime = {
    platform: options?.platform ?? 'darwin',
    resolvePath: options?.resolvePath,
    watchNative: (root, listener, watchOptions) => {
      if (synchronousFailures > 0) {
        synchronousFailures -= 1;
        throw Object.assign(new Error('native watch creation failed'), {
          code: options?.nativeCode ?? 'EIO',
        });
      }
      const watcher = new TestNativeWatcher();
      attempts.push({
        root,
        recursive: watchOptions?.recursive !== false,
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
    reportError: (error) => {
      reportedErrors.push(error);
    },
  };
  return {
    service: createWatchService(runtime),
    attempts,
    retries,
    reportedErrors,
    attempt: (index) => requiredAt(attempts, index),
    retry: (index) => requiredAt(retries, index),
  };
}

function fakeChokidarRig(): {
  readonly watchers: TestChokidarWatcher[];
  at(index: number): TestChokidarWatcher;
} {
  const watchers: TestChokidarWatcher[] = [];
  chokidarMockState.factory = (options) => {
    const watcher = new TestChokidarWatcher(options);
    watchers.push(watcher);
    return watcher;
  };
  return {
    watchers,
    at: (index) => requiredAt(watchers, index),
  };
}

function skillTreeIgnored(root: string): (path: string) => boolean {
  const prefix = root.replaceAll('\\', '/').replace(/\/+$/, '');
  return (path: string): boolean => {
    const norm = path.replaceAll('\\', '/');
    if (norm === prefix) return false;
    if (!norm.startsWith(`${prefix}/`)) return true;
    const [first, second, ...rest] = norm.slice(prefix.length + 1).split('/');
    if (first !== '.kimi-code' && first !== '.agents') return true;
    if (second === undefined) return false;
    if (second !== 'skills') return true;
    return rest.some((segment) => segment === 'node_modules' || segment.startsWith('.'));
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

  it('watches the resolved root and reports changes under the requested path', () => {
    const rig = signalRig({
      platform: 'win32',
      resolvePath: (path) => path.replace('/RUNNER~1/', '/runneradmin/'),
    });
    const events: WatchChange[] = [];
    const ignoredPaths: string[] = [];
    handle = rig.service.watch('/Users/RUNNER~1/repo', {
      signal: true,
      ignored: (path) => {
        ignoredPaths.push(path);
        return path.includes('node_modules');
      },
    });
    handle.onDidChange((event) => events.push(event));

    rig.attempt(0).emit('node_modules/pkg/index.js');
    rig.attempt(0).emit('src/index.ts');

    expect(rig.attempt(0).root).toBe('/Users/runneradmin/repo');
    expect(ignoredPaths).toEqual([
      join('/Users/RUNNER~1/repo', 'node_modules/pkg/index.js'),
      join('/Users/RUNNER~1/repo', 'src/index.ts'),
    ]);
    expect(events).toEqual([
      { path: '/Users/RUNNER~1/repo', action: 'modified', kind: 'directory' },
    ]);
  });

  it('does not invalidate when an ignored native signal path is a child starting with two dots', () => {
    const rig = signalRig();
    const events: WatchChange[] = [];
    handle = rig.service.watch('/repo', {
      signal: true,
      ignored: (path) => path.includes('..cache'),
    });
    handle.onDidChange((event) => events.push(event));

    rig.attempt(0).emit(join('..cache', 'index.json'));

    expect(events).toEqual([]);
  });

  it('maps resolved children starting with two dots back to the requested path', () => {
    const rig = signalRig({
      platform: 'win32',
      resolvePath: (path) => path.replace('/RUNNER~1/', '/runneradmin/'),
    });
    const ignoredPaths: string[] = [];
    handle = rig.service.watch('/Users/RUNNER~1/repo', {
      signal: true,
      ignored: (path) => {
        ignoredPaths.push(path);
        return false;
      },
    });

    rig.attempt(0).emit(join('..cache', 'index.json'));

    expect(ignoredPaths).toEqual([join('/Users/RUNNER~1/repo', '..cache/index.json')]);
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
    const root = await longTempDir('watch-fallback-');
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

  it('reports chokidar changes under the requested path when the watched root resolves elsewhere', async () => {
    const base = await longTempDir('watch-resolved-');
    const target = join(base, 'long-name');
    const requested = join(base, 'LONG~1');
    await mkdir(target);
    await symlink(target, requested, 'junction');
    const resolvedTarget = await realpath(target);
    const service = createWatchService({
      platform: 'win32',
      resolvePath: (path) => (path === requested ? resolvedTarget : path),
      watchNative: () => {
        throw new Error('native watch must not be used without signal mode');
      },
      scheduleRetry: () => ({ dispose: () => {} }),
      reportError: () => undefined,
    });
    const events: WatchChange[] = [];
    const ignoredPaths: string[] = [];
    try {
      handle = service.watch(requested, {
        depth: 0,
        ignored: (path) => {
          ignoredPaths.push(path);
          return false;
        },
      });
      handle.onDidChange((event) => events.push(event));
      await handle.ready;

      await writeFile(join(target, 'config.toml'), 'x');

      await expect
        .poll(() => events.some((e) => e.path === join(requested, 'config.toml') && e.action === 'created'))
        .toBe(true);
      expect(events.every((e) => e.path.startsWith(requested))).toBe(true);
      expect(ignoredPaths.every((path) => path.startsWith(requested))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('uses chokidar for signal watches on platforms without native recursive watch', async () => {
    const root = await longTempDir('watch-linux-signal-');
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

describe('watch Windows UNC fallback', () => {
  let handle: WatchHandle | undefined;

  afterEach(() => {
    handle?.dispose();
    handle = undefined;
    chokidarMockState.factory = undefined;
  });

  it.each([
    '\\\\wsl$\\Ubuntu\\home\\devuser\\workspace',
    '//wsl$/Ubuntu/home/devuser/workspace',
    '\\\\wsl.localhost\\Ubuntu\\home\\devuser\\workspace',
    '//wsl.localhost/Ubuntu/home/devuser/workspace',
    '\\\\server\\share\\repo',
    '\\\\?\\UNC\\wsl$\\Ubuntu\\home\\devuser\\workspace',
  ])('falls back to chokidar and resolves ready when Windows recursive watch throws EISDIR on %s', async (root) => {
    const rig = signalRig({ platform: 'win32', synchronousFailures: 1, nativeCode: 'EISDIR' });
    const chokidar = fakeChokidarRig();
    const events: WatchChange[] = [];
    handle = rig.service.watch(root, { signal: true });
    handle.onDidChange((event) => events.push(event));

    await handle.ready;

    expect(chokidar.at(0).paths).toEqual([root]);
    expect(chokidar.at(0).options.depth).toBeUndefined();
    expect(chokidar.at(0).options.usePolling).toBe(true);
    expect(rig.retries).toEqual([]);
    expect(rig.reportedErrors).toEqual([]);

    const skillFile = `${root}/.agents/skills/demo/SKILL.md`;
    chokidar.at(0).emit('all', 'add', skillFile);
    expect(events).toEqual([{ path: skillFile, action: 'created', kind: 'file' }]);
  });

  it('closes the native watcher, invalidates, and falls back when an active Windows UNC watcher emits EISDIR', async () => {
    const root = '\\\\wsl$\\Ubuntu\\home\\devuser\\workspace';
    const rig = signalRig({ platform: 'win32' });
    const chokidar = fakeChokidarRig();
    const events: WatchChange[] = [];
    handle = rig.service.watch(root, { signal: true });
    handle.onDidChange((event) => events.push(event));
    await handle.ready;

    rig.attempt(0).watcher.fail('EISDIR');

    expect(rig.attempt(0).watcher.closed).toBe(true);
    expect(chokidar.watchers).toHaveLength(1);
    expect(chokidar.at(0).paths).toEqual([root]);
    expect(chokidar.at(0).options.usePolling).toBe(true);
    expect(rig.retries).toEqual([]);
    expect(rig.reportedErrors).toEqual([]);
    expect(events).toEqual([{ path: root, action: 'modified', kind: 'directory' }]);
  });

  it.each([
    'C:\\work\\repo',
    'C:/work/repo',
    '\\\\?\\C:\\work\\repo',
    '\\\\?\\Volume{26a21bda-a627-11d7-9931-806e6f6e6963}\\work\\repo',
  ])('keeps EISDIR on local Windows path %s on the native retry path', (root) => {
    const rig = signalRig({ platform: 'win32', synchronousFailures: 1, nativeCode: 'EISDIR' });
    const chokidar = fakeChokidarRig();
    handle = rig.service.watch(root, { signal: true });

    expect(chokidar.watchers).toEqual([]);
    expect(rig.retries.map((retry) => retry.delayMs)).toEqual([1000]);
    expect(rig.reportedErrors).toHaveLength(1);
    expect((rig.reportedErrors[0] as NodeJS.ErrnoException).code).toBe('EISDIR');

    rig.retry(0).run();
    expect(rig.attempts).toHaveLength(1);
    expect(rig.attempt(0).root).toBe(root);
    expect(rig.attempt(0).recursive).toBe(true);
  });

  it('keeps EISDIR on non-Windows platforms on the native retry path', () => {
    const rig = signalRig({ platform: 'darwin', synchronousFailures: 1, nativeCode: 'EISDIR' });
    const chokidar = fakeChokidarRig();
    handle = rig.service.watch('//server/share/repo', { signal: true });

    expect(chokidar.watchers).toEqual([]);
    expect(rig.retries.map((retry) => retry.delayMs)).toEqual([1000]);
    expect(rig.reportedErrors).toHaveLength(1);
  });

  it('uses native recursive watch for a local Windows signal root', async () => {
    const rig = signalRig({ platform: 'win32' });
    const chokidar = fakeChokidarRig();
    handle = rig.service.watch('C:\\work\\repo', { signal: true });
    await handle.ready;

    expect(rig.attempt(0).root).toBe('C:\\work\\repo');
    expect(rig.attempt(0).recursive).toBe(true);
    expect(chokidar.watchers).toEqual([]);
  });

  it.each([
    { code: 'EISDIR', root: '\\\\wsl$\\Ubuntu\\home\\devuser\\workspace', usePolling: true },
    {
      code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
      root: '\\\\wsl.localhost\\Ubuntu\\home\\devuser\\workspace',
      usePolling: true,
    },
    { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', root: 'C:\\work\\repo', usePolling: undefined },
    { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', root: '\\\\?\\C:\\work\\repo', usePolling: undefined },
  ])(
    'passes depth 0 to chokidar when a listing watch falls back with $code on $root',
    async ({ code, root, usePolling }) => {
      const rig = signalRig({ platform: 'win32', synchronousFailures: 1, nativeCode: code });
      const chokidar = fakeChokidarRig();
      handle = rig.service.watch(root, { signal: true, listing: false, recursive: false, depth: 10 });

      await handle.ready;

      expect(chokidar.at(0).options.depth).toBe(0);
      expect(chokidar.at(0).options.usePolling).toBe(usePolling);
      expect(rig.retries).toEqual([]);
      expect(rig.reportedErrors).toEqual([]);
    },
  );

  it('passes depth 0 to chokidar when a listing watch without recursive false falls back with EISDIR', async () => {
    const rig = signalRig({ platform: 'win32', synchronousFailures: 1, nativeCode: 'EISDIR' });
    const chokidar = fakeChokidarRig();
    handle = rig.service.watch('//wsl$/Ubuntu/home/devuser/workspace', { signal: true, listing: false });

    await handle.ready;

    expect(chokidar.at(0).options.depth).toBe(0);
    expect(chokidar.at(0).options.usePolling).toBe(true);
  });

  it('passes depth 0 to chokidar when recursive is false even if a depth limit is set', () => {
    const rig = signalRig({ platform: 'linux' });
    const chokidar = fakeChokidarRig();
    handle = rig.service.watch('/repo', { recursive: false, depth: 10 });

    expect(chokidar.at(0).options.depth).toBe(0);
    expect(chokidar.at(0).options.usePolling).toBeUndefined();
  });

  it.each([
    {
      code: 'EISDIR',
      root: '\\\\wsl.localhost\\Ubuntu\\home\\devuser\\workspace',
      usePolling: true,
    },
    { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', root: '\\\\server\\share\\repo', usePolling: true },
    { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', root: 'C:\\work\\repo', usePolling: undefined },
  ])(
    'preserves the caller depth limit when native recursive watch falls back with $code on $root',
    async ({ code, root, usePolling }) => {
      const rig = signalRig({ platform: 'win32', synchronousFailures: 1, nativeCode: code });
      const chokidar = fakeChokidarRig();
      handle = rig.service.watch(root, { signal: true, depth: 10 });

      await handle.ready;

      expect(chokidar.at(0).options.depth).toBe(10);
      expect(chokidar.at(0).options.usePolling).toBe(usePolling);
    },
  );

  it.each([
    { platform: 'win32' as const, root: 'C:\\work\\repo', usePolling: undefined },
    { platform: 'win32' as const, root: '\\\\?\\C:\\work\\repo', usePolling: undefined },
    { platform: 'win32' as const, root: '\\\\wsl$\\Ubuntu\\home\\devuser\\workspace', usePolling: true },
    { platform: 'linux' as const, root: '//wsl$/Ubuntu/home/devuser/workspace', usePolling: undefined },
    { platform: 'darwin' as const, root: '//server/share/repo', usePolling: undefined },
  ])(
    'passes usePolling=$usePolling to direct chokidar watch on $platform $root',
    async ({ platform, root, usePolling }) => {
      const rig = signalRig({ platform });
      const chokidar = fakeChokidarRig();
      handle = rig.service.watch(root, { depth: 3 });

      await handle.ready;

      expect(chokidar.at(0).options.depth).toBe(3);
      expect(chokidar.at(0).options.usePolling).toBe(usePolling);
    },
  );

  it('does not enable polling when a non-Windows signal watch falls back to chokidar', async () => {
    const rig = signalRig({
      platform: 'darwin',
      synchronousFailures: 1,
      nativeCode: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
    });
    const chokidar = fakeChokidarRig();
    handle = rig.service.watch('//server/share/repo', { signal: true });

    await handle.ready;

    expect(chokidar.at(0).options.usePolling).toBeUndefined();
  });

  it('forwards the ignored pruning predicate to chokidar on WSL UNC fallback', async () => {
    const root = '\\\\wsl$\\Ubuntu\\home\\devuser\\workspace';
    const rig = signalRig({ platform: 'win32', synchronousFailures: 1, nativeCode: 'EISDIR' });
    const chokidar = fakeChokidarRig();
    handle = rig.service.watch(root, { signal: true, ignored: skillTreeIgnored(root) });

    await handle.ready;

    expect(chokidar.at(0).options.usePolling).toBe(true);
    const ignored = chokidar.at(0).options.ignored;
    expect(ignored).toBeDefined();
    expect(ignored?.('//wsl$/Ubuntu/home/devuser/workspace/.kimi-code/skills/demo/SKILL.md')).toBe(false);
    expect(ignored?.('\\\\wsl$\\Ubuntu\\home\\devuser\\workspace\\.agents\\skills\\demo\\SKILL.md')).toBe(false);
    expect(ignored?.('//wsl$/Ubuntu/home/devuser/workspace/node_modules/pkg/index.js')).toBe(true);
    expect(ignored?.('//wsl$/Ubuntu/home/devuser/workspace/.agents/skills/node_modules/pkg/SKILL.md')).toBe(true);
    expect(ignored?.('//wsl$/Ubuntu/home/devuser/workspace/.agents/skills/.hidden/SKILL.md')).toBe(true);
    expect(ignored?.('//wsl$/Ubuntu/home/devuser/workspace/src/index.ts')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('resolves ready and reports new files through real chokidar after EISDIR on a UNC root', async () => {
    const base = await longTempDir('watch-unc-eisdir-');
    const uncRoot = `/${base}`;
    const rig = signalRig({ platform: 'win32', synchronousFailures: 1, nativeCode: 'EISDIR' });
    const events: WatchChange[] = [];
    try {
      handle = rig.service.watch(uncRoot, { signal: true });
      handle.onDidChange((event) => events.push(event));
      await handle.ready;

      expect(rig.retries).toEqual([]);
      expect(rig.reportedErrors).toEqual([]);

      const file = join(base, 'new.txt');
      await writeFile(file, 'v1');

      await expect.poll(() => events.some((e) => e.path === file && e.action === 'created')).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('does not scan subdirectories on real chokidar when a listing UNC watch falls back', async () => {
    const base = await longTempDir('watch-unc-listing-');
    const uncRoot = `/${base}`;
    await mkdir(join(base, 'sub'));
    await writeFile(join(base, 'sub', 'nested.txt'), 'preexisting');
    const rig = signalRig({ platform: 'win32', synchronousFailures: 1, nativeCode: 'EISDIR' });
    const visited: string[] = [];
    const events: WatchChange[] = [];
    try {
      handle = rig.service.watch(uncRoot, {
        signal: true,
        listing: false,
        recursive: false,
        ignored: (path) => {
          visited.push(path);
          return false;
        },
      });
      handle.onDidChange((event) => events.push(event));
      await handle.ready;

      expect(visited.some((path) => path.endsWith('nested.txt'))).toBe(false);

      const topFile = join(base, 'top.txt');
      await writeFile(topFile, 'v1');
      await expect.poll(() => events.some((e) => e.path === topFile && e.action === 'created')).toBe(true);
      expect(events.some((e) => e.path.endsWith('nested.txt'))).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('does not descend into pruned directories on real chokidar UNC fallback', async () => {
    const base = await longTempDir('watch-unc-prune-');
    const uncRoot = `/${base}`;
    await mkdir(join(base, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(base, 'node_modules', 'pkg', 'index.js'), 'x');
    await mkdir(join(base, '.cache', 'pkg'), { recursive: true });
    await writeFile(join(base, '.cache', 'pkg', 'SKILL.md'), 'x');
    await mkdir(join(base, 'src'), { recursive: true });
    await writeFile(join(base, 'src', 'index.ts'), 'x');
    await mkdir(join(base, '.agents', 'skills', 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(base, '.agents', 'skills', 'node_modules', 'pkg', 'SKILL.md'), 'x');
    await mkdir(join(base, '.agents', 'skills', '.hidden'), { recursive: true });
    await writeFile(join(base, '.agents', 'skills', '.hidden', 'SKILL.md'), 'x');
    await mkdir(join(base, '.agents', 'skills', 'demo'), { recursive: true });
    const skillFile = join(base, '.agents', 'skills', 'demo', 'SKILL.md');
    await writeFile(skillFile, 'x');
    const rig = signalRig({ platform: 'win32', synchronousFailures: 1, nativeCode: 'EISDIR' });
    const prune = skillTreeIgnored(base);
    const visited: string[] = [];
    try {
      handle = rig.service.watch(uncRoot, {
        signal: true,
        ignored: (path) => {
          visited.push(path);
          return prune(path);
        },
      });
      await handle.ready;

      expect(visited).toContain(skillFile);
      expect(visited.some((path) => path.includes('node_modules/pkg'))).toBe(false);
      expect(visited.some((path) => path.includes('.cache/pkg'))).toBe(false);
      expect(visited.some((path) => path.includes('.agents/skills/.hidden/'))).toBe(false);
      expect(visited.some((path) => path.endsWith('index.ts'))).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
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

  it('does not emit sibling flood names when watching candidate paths', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-candidates-'));
    const kimi = join(root, '.kimi-code');
    const sessions = join(kimi, 'sessions', 's1.json');
    await mkdir(join(kimi, 'sessions'), { recursive: true });
    await writeFile(join(root, 'ck_0001'), 'x');
    await writeFile(sessions, 'old');
    const events: WatchChange[] = [];
    const file = join(kimi, 'local.toml');
    handle = watchCandidates(root, [file]);
    handle.onDidChange((e) => events.push(e));
    await handle.ready;

    await writeFile(join(root, 'ck_0002'), 'y');
    await writeFile(sessions, 'new');
    await wait(300);
    expect(events.some((e) => e.path.includes('ck_') || e.path.includes('sessions'))).toBe(false);

    await writeFile(file, 'hello');
    await expect.poll(() => events.some((e) => e.path === file), { timeout: 5000 }).toBe(true);
    expect(events.some((e) => e.path === kimi || e.path === root || e.path.includes('sessions'))).toBe(
      false,
    );
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

  it('does not start a filesystem watch when watch is disabled', async () => {
    root = await mkdtemp(join(tmpdir(), 'watch-disabled-'));
    setWatchEnabled(false);
    try {
      const events = await start();
      await writeFile(join(root, 'a.txt'), 'x');
      await wait(300);
      expect(events).toHaveLength(0);
    } finally {
      setWatchEnabled(true);
    }
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

  it.skipIf(process.platform !== 'win32')(
    'reports changes under an 8.3 short path on Windows',
    async () => {
      root = await mkdtemp(join(tmpdir(), 'watch-'));
      const long = join(root, 'long directory name');
      await mkdir(long);
      const short = execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`], {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
      }).trim();
      expect(basename(short)).toMatch(/~\d/);
      expect(existsSync(short)).toBe(true);
      await writeFile(join(long, 'config.toml'), 'v1');
      const events: WatchChange[] = [];
      handle = watch(short, { depth: 0 });
      handle.onDidChange((e) => events.push(e));
      await handle.ready;

      await writeFile(join(long, 'config.toml'), 'v2');
      await writeFile(join(long, 'added.toml'), 'v1');

      await expect
        .poll(() => events, { timeout: 10000 })
        .toEqual(
          expect.arrayContaining([
            { path: join(short, 'config.toml'), action: 'modified', kind: 'file' },
            { path: join(short, 'added.toml'), action: 'created', kind: 'file' },
          ]),
        );
    },
    30000,
  );

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
