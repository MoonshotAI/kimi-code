/**
 * `sessionFsWatch` domain (L2) — verifies confinement to the declared subtree,
 * workspace-relative path mapping, debounce coalescing, window truncation,
 * `.gitignore` filtering and handle lifecycle, using a fake os watcher.
 */

import { isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LifecycleScope } from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { FsChangeEvent } from '#/session/sessionFs/fsWatch';

import { ISessionFsWatchService, isFsWatchKeyWithin, normalizeFsWatchKey } from '#/session/sessionFs/fsWatch';
import { SessionFsWatchService } from '#/session/sessionFs/fsWatchService';

import { fakeHostFsWatch, type FakeWatch } from './stubs';

const WORK_DIR = '/repo';

void SessionFsWatchService;

function stubWorkspace(): ISessionWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir: WORK_DIR,
    additionalDirs: [],
    setWorkDir: () => {},
    setAdditionalDirs: () => {},
    resolve: (rel) => (isAbsolute(rel) ? rel : resolve(WORK_DIR, rel)),
    isWithin: (abs) => {
      const r = relative(WORK_DIR, abs);
      return r === '' || (!r.startsWith('..') && !isAbsolute(r));
    },
    assertAllowed: (abs) => abs,
    addAdditionalDir: () => {},
    removeAdditionalDir: () => {},
  };
}

function fakeHostFs(gitignore?: string): IHostFileSystem {
  return {
    _serviceBrand: undefined,
    readText: async (p: string) => {
      if (gitignore !== undefined && p === join(WORK_DIR, '.gitignore')) return gitignore;
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    },
  } as unknown as IHostFileSystem;
}

interface Harness {
  readonly svc: ISessionFsWatchService;
  readonly watch: FakeWatch;
  readonly events: FsChangeEvent[];
}

function makeSession(gitignore?: string, hostFs?: IHostFileSystem): Harness {
  const watch = fakeHostFsWatch();
  const host = createScopedTestHost();
  const session = host.child(LifecycleScope.Session, 's1', [
    stubPair(ISessionWorkspaceContext, stubWorkspace()),
    stubPair(IHostFsWatchService, watch.service),
    stubPair(IHostFileSystem, hostFs ?? fakeHostFs(gitignore)),
  ]);
  const svc = session.accessor.get(ISessionFsWatchService);
  const events: FsChangeEvent[] = [];
  svc.onDidChangeFiles((e) => events.push(e));
  disposers.push(() => host.dispose());
  return { svc, watch, events };
}

const disposers: Array<() => void> = [];

describe('SessionFsWatchService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const d of disposers.splice(0)) d();
    vi.useRealTimers();
  });

  it('starts the os watcher on the workspace root for a non-empty subscription', () => {
    const { svc, watch } = makeSession();
    svc.setWatchedPaths(['src']);
    expect(watch.watchCalls).toEqual([WORK_DIR]);
    expect(svc.watchedPaths).toEqual(['src']);
  });

  it('drops events outside the subscribed subtree', () => {
    const { svc, watch, events } = makeSession();
    svc.setWatchedPaths(['src']);

    watch.fire('src/a.ts', 'created');
    watch.fire('lib/b.ts', 'created');
    vi.advanceTimersByTime(200);

    expect(events).toHaveLength(1);
    expect(events[0]?.changes).toEqual([{ path: 'src/a.ts', change: 'created', kind: 'file' }]);
  });

  it('coalesces changes within a window into one event', () => {
    const { svc, watch, events } = makeSession();
    svc.setWatchedPaths(['.']);

    watch.fire('a.ts', 'created');
    watch.fire('b.ts', 'modified');
    watch.fire('c.ts', 'deleted');
    vi.advanceTimersByTime(200);

    expect(events).toHaveLength(1);
    expect(events[0]?.coalesced_window_ms).toBe(200);
    expect(events[0]?.changes).toHaveLength(3);
  });

  it('marks the event truncated when the window overflows', () => {
    const { svc, watch, events } = makeSession();
    svc.setWatchedPaths(['.']);

    for (let i = 0; i < 501; i++) watch.fire(`f${i}.ts`, 'created');
    vi.advanceTimersByTime(200);

    expect(events).toHaveLength(1);
    expect(events[0]?.truncated).toBe(true);
    expect(events[0]?.changes).toEqual([]);
    expect(events[0]?.count).toBe(501);
  });

  it('filters out `.gitignore`d paths once loaded', async () => {
    const { svc, watch, events } = makeSession('dist/\n');
    svc.setWatchedPaths(['.']);
    await Promise.resolve();
    await Promise.resolve();

    watch.fire('dist/x.js', 'created');
    watch.fire('src/keep.ts', 'created');
    vi.advanceTimersByTime(200);

    expect(events).toHaveLength(1);
    expect(events[0]?.changes.map((c) => c.path)).toEqual(['src/keep.ts']);
  });

  it('lets events through while the initial `.gitignore` load is in flight', async () => {
    let releaseLoad: ((content: string) => void) | undefined;
    const pendingLoad = new Promise<string>((res) => {
      releaseLoad = res;
    });
    const hostFs = {
      _serviceBrand: undefined,
      readText: async (p: string) => {
        if (p === join(WORK_DIR, '.gitignore')) return pendingLoad;
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
    } as unknown as IHostFileSystem;
    const { svc, watch, events } = makeSession(undefined, hostFs);
    svc.setWatchedPaths(['.']);

    // The rules are not loaded yet: filtering is conservative (only `.git/`),
    // so a path that will later turn out to be ignored still gets delivered.
    watch.fire('dist/x.js', 'created');
    vi.advanceTimersByTime(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.changes.map((c) => c.path)).toEqual(['dist/x.js']);

    releaseLoad!('dist/\n');
    await pendingLoad;
    await Promise.resolve();
    await Promise.resolve();

    watch.fire('dist/y.js', 'created');
    vi.advanceTimersByTime(200);
    expect(events).toHaveLength(1);
  });

  it('rebuilds the matcher when the workspace `.gitignore` changes', async () => {
    let gitignore = 'dist/\n';
    const hostFs = {
      _serviceBrand: undefined,
      readText: async (p: string) => {
        if (p === join(WORK_DIR, '.gitignore')) return gitignore;
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
    } as unknown as IHostFileSystem;
    const { svc, watch, events } = makeSession(undefined, hostFs);
    svc.setWatchedPaths(['.']);
    await Promise.resolve();
    await Promise.resolve();

    watch.fire('dist/a.js', 'created');
    vi.advanceTimersByTime(200);
    expect(events).toHaveLength(0);

    gitignore = 'build/\n';
    watch.fire('.gitignore', 'modified');
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(200);

    watch.fire('dist/b.js', 'created');
    watch.fire('build/c.js', 'created');
    vi.advanceTimersByTime(200);

    // The `.gitignore` change itself is a delivered event; afterwards
    // `dist/` passes (no longer ignored) and `build/` is filtered.
    expect(events).toHaveLength(2);
    expect(events[0]?.changes.map((c) => c.path)).toEqual(['.gitignore']);
    expect(events[1]?.changes.map((c) => c.path)).toEqual(['dist/b.js']);
  });

  it('rejects paths that escape the workspace', () => {
    const { svc } = makeSession();
    expect(() => svc.setWatchedPaths(['../x'])).toThrowError(/escapes workspace|rejected/);
    expect(() => svc.setWatchedPaths(['/abs'])).toThrowError(/rejected/);
  });

  it('disposes the os handle when the subscription set becomes empty', () => {
    const { svc, watch } = makeSession();
    svc.setWatchedPaths(['src']);
    expect(watch.disposed()).toBe(false);
    svc.setWatchedPaths([]);
    expect(watch.disposed()).toBe(true);
  });

  it('does not fire after the service is disposed', () => {
    const { svc, watch, events } = makeSession();
    svc.setWatchedPaths(['.']);
    watch.fire('a.ts', 'created');
    (svc as unknown as { dispose: () => void }).dispose();
    vi.advanceTimersByTime(200);
    expect(events).toHaveLength(0);
  });
});

describe('fsWatch key helpers', () => {
  it('normalizes keys lexically and folds case on macOS/Windows', () => {
    const folded = process.platform === 'darwin' || process.platform === 'win32';
    expect(normalizeFsWatchKey('/A//B/../C')).toBe(folded ? '/a/c' : '/A/C');
  });

  it('checks containment with a separator boundary', () => {
    expect(isFsWatchKeyWithin('/a/b', '/a/b')).toBe(true);
    expect(isFsWatchKeyWithin('/a/b/c', '/a/b')).toBe(true);
    expect(isFsWatchKeyWithin('/a/bc', '/a/b')).toBe(false);
    expect(isFsWatchKeyWithin('/a', '/a/b')).toBe(false);
  });
});

describe('SessionFsWatchService ensured roots and dirty ticks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const d of disposers.splice(0)) d();
    vi.useRealTimers();
  });

  it('starts the os watcher for an ensured root and reports it as a watched root', () => {
    const { svc, watch } = makeSession();
    svc.ensureWatchedRoots([WORK_DIR]);
    expect(watch.watchCalls).toEqual([WORK_DIR]);
    expect(svc.watchedRoots).toEqual([WORK_DIR]);
    expect(svc.watchedPaths).toEqual([]);
  });

  it('keeps the os watcher alive when client subscriptions empty but ensured roots remain', () => {
    const { svc, watch } = makeSession();
    svc.ensureWatchedRoots([WORK_DIR]);
    svc.setWatchedPaths(['src']);
    svc.setWatchedPaths([]);
    expect(watch.disposed()).toBe(false);
    expect(svc.watchedRoots).toEqual([WORK_DIR]);
  });

  it('skips ensured roots already covered by an existing watched root', () => {
    const { svc, watch } = makeSession();
    svc.ensureWatchedRoots([WORK_DIR]);
    svc.ensureWatchedRoots([join(WORK_DIR, 'sub')]);
    expect(watch.watchCalls).toEqual([WORK_DIR]);
  });

  it('watches an ensured root outside the workspace with a dedicated handle folded into dirty state only', () => {
    const EXT = '/ext-root';
    const { svc, watch, events } = makeSession();
    svc.ensureWatchedRoots([EXT]);
    expect(new Set(watch.watchCalls)).toEqual(new Set([WORK_DIR, EXT]));
    const ext = watch.handles.find((h) => h.root === EXT);
    expect(ext).toBeDefined();

    ext!.fire('a.ts', 'modified');
    vi.advanceTimersByTime(200);

    expect(svc.dirtyTickFor(join(EXT, 'a.ts'))).toBe(1);
    expect(events).toEqual([]);
  });

  it('increments and exposes per-path dirty ticks before the debounce flush', () => {
    const { svc, watch } = makeSession();
    svc.ensureWatchedRoots([WORK_DIR]);
    expect(svc.currentTick).toBe(0);

    const a = join(WORK_DIR, 'a.ts');
    watch.fire('a.ts', 'created');
    expect(svc.currentTick).toBe(1);
    expect(svc.dirtyTickFor(a)).toBe(1);
    vi.advanceTimersByTime(200);
    expect(svc.dirtyTickFor(a)).toBe(1);

    watch.fire('b.ts', 'modified');
    vi.advanceTimersByTime(200);
    expect(svc.dirtyTickFor(join(WORK_DIR, 'b.ts'))).toBe(2);
    expect(svc.dirtyTickFor(a)).toBe(1);
  });

  it('marks every watched root dirty for a truncated window', () => {
    const { svc, watch } = makeSession();
    svc.ensureWatchedRoots([WORK_DIR]);
    for (let i = 0; i < 501; i++) watch.fire(`f${i}.ts`, 'created');
    vi.advanceTimersByTime(200);

    expect(svc.dirtyTickFor(join(WORK_DIR, 'f0.ts'))).toBe(1);
    expect(svc.rootDirtyTickFor(WORK_DIR)).toBe(501);
  });

  it('folds buffered dirty signals when the window is cleared without flushing', () => {
    const { svc, watch } = makeSession();
    svc.setWatchedPaths(['src']);
    watch.fire('src/a.ts', 'modified');
    svc.setWatchedPaths([]);
    expect(svc.dirtyTickFor(join(WORK_DIR, 'src/a.ts'))).toBe(1);
  });
});
