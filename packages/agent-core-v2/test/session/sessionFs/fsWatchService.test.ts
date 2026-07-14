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
import {
  type HostFsChange,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { FsChangeEvent } from '@moonshot-ai/protocol';

import { ISessionFsWatchService } from '#/session/sessionFs/fsWatch';
import { SessionFsWatchService } from '#/session/sessionFs/fsWatchService';

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

interface FakeWatch {
  readonly service: IHostFsWatchService;
  readonly watchCalls: string[];
  fire: (rel: string, action: HostFsChange['action'], kind?: HostFsChange['kind']) => void;
  readonly disposed: () => boolean;
}

function fakeHostFsWatch(): FakeWatch {
  const watchCalls: string[] = [];
  let listener: ((e: HostFsChange) => void) | undefined;
  let disposed = false;
  const handle: IHostFsWatchHandle = {
    onDidChange: (l) => {
      listener = l;
      return { dispose: () => (listener = undefined) };
    },
    dispose: () => {
      disposed = true;
      listener = undefined;
    },
  };
  const service: IHostFsWatchService = {
    _serviceBrand: undefined,
    watch: (path) => {
      watchCalls.push(path);
      disposed = false;
      return handle;
    },
  };
  return {
    service,
    watchCalls,
    fire: (rel, action, kind = 'file') =>
      listener?.({ path: join(WORK_DIR, rel), action, kind }),
    disposed: () => disposed,
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

function makeSession(gitignore?: string): Harness {
  const watch = fakeHostFsWatch();
  const host = createScopedTestHost();
  const session = host.child(LifecycleScope.Session, 's1', [
    stubPair(ISessionWorkspaceContext, stubWorkspace()),
    stubPair(IHostFsWatchService, watch.service),
    stubPair(IHostFileSystem, fakeHostFs(gitignore)),
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
