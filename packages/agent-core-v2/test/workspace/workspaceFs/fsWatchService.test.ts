/**
 * `workspaceFs` fs-watch — verifies the shared os watcher fan-out:
 * confinement to each subscription's declared subtree, workspace-relative
 * path mapping, per-subscription debounce coalescing and window truncation,
 * `.gitignore` filtering, and the handle lifecycle (one os watch per handler
 * no matter how many subscriptions), using a fake os watcher.
 */

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LifecycleScope } from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  type HostFsChange,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import type { FsChangeEvent } from '#/workspace/workspaceFs/fsWatch';

import { IWorkspaceFsWatchService } from '#/workspace/workspaceFs/fsWatch';
import { WorkspaceFsWatchService } from '#/workspace/workspaceFs/fsWatchService';

const WORK_DIR = '/repo';

void WorkspaceFsWatchService;

function stubWorkspaceContext(): IWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workspaceId: 'w',
    cwd: WORK_DIR,
    source: 'local',
    meta: { id: 'w', root: WORK_DIR, name: 'proj', createdAt: 1, lastOpenedAt: 1 },
    persistenceScope: 'sessions/w',
    osBackendId: 'local',
    persistenceBackendId: 'local',
  };
}

function stubWorkspaceDirs(): IWorkspaceDirs {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    additionalDirs: [],
    onDidChange: () => ({ dispose: () => {} }),
    addDir: () => Promise.reject(new Error('not supported in tests')),
    mergeAdditionalDirs: () => Promise.resolve(),
    sessionInfo: () => {
      throw new Error('not supported in tests');
    },
  };
}

interface FakeWatch {
  readonly service: IHostFsWatchService;
  readonly watchCalls: string[];
  fire: (rel: string, action: HostFsChange['action'], kind?: HostFsChange['kind']) => void;
  readonly disposedCount: () => number;
}

function fakeHostFsWatch(): FakeWatch {
  const watchCalls: string[] = [];
  let listener: ((e: HostFsChange) => void) | undefined;
  let disposedCount = 0;
  const handle: IHostFsWatchHandle = {
    onDidChange: (l) => {
      listener = l;
      return { dispose: () => (listener = undefined) };
    },
    dispose: () => {
      disposedCount += 1;
      listener = undefined;
    },
  };
  const service: IHostFsWatchService = {
    _serviceBrand: undefined,
    watch: (path) => {
      watchCalls.push(path);
      return handle;
    },
  };
  return {
    service,
    watchCalls,
    fire: (rel, action, kind = 'file') =>
      listener?.({ path: join(WORK_DIR, rel), action, kind }),
    disposedCount: () => disposedCount,
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
  readonly svc: IWorkspaceFsWatchService;
  readonly watch: FakeWatch;
}

function makeWorkspace(gitignore?: string): Harness {
  const watch = fakeHostFsWatch();
  const host = createScopedTestHost();
  const workspace = host.child(LifecycleScope.Workspace, 'w1', [
    stubPair(IWorkspaceContext, stubWorkspaceContext()),
    stubPair(IWorkspaceDirs, stubWorkspaceDirs()),
    stubPair(IHostFsWatchService, watch.service),
    stubPair(IHostFileSystem, fakeHostFs(gitignore)),
  ]);
  const svc = workspace.accessor.get(IWorkspaceFsWatchService);
  disposers.push(() => host.dispose());
  return { svc, watch };
}

function collect(sub: { onDidChangeFiles: (l: (e: FsChangeEvent) => void) => unknown }): FsChangeEvent[] {
  const events: FsChangeEvent[] = [];
  sub.onDidChangeFiles((e) => events.push(e));
  return events;
}

const disposers: Array<() => void> = [];

describe('WorkspaceFsWatchService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const d of disposers.splice(0)) d();
    vi.useRealTimers();
  });

  it('starts the os watcher on the workspace root for a non-empty subscription', () => {
    const { svc, watch } = makeWorkspace();
    const sub = svc.subscribe();
    sub.setWatchedPaths(['src']);
    expect(watch.watchCalls).toEqual([WORK_DIR]);
    expect(sub.watchedPaths).toEqual(['src']);
  });

  it('drops events outside the subscribed subtree', () => {
    const { svc, watch } = makeWorkspace();
    const sub = svc.subscribe();
    sub.setWatchedPaths(['src']);
    const events = collect(sub);

    watch.fire('src/a.ts', 'created');
    watch.fire('lib/b.ts', 'created');
    vi.advanceTimersByTime(200);

    expect(events).toHaveLength(1);
    expect(events[0]?.changes).toEqual([{ path: 'src/a.ts', change: 'created', kind: 'file' }]);
  });

  it('coalesces changes within a window into one event', () => {
    const { svc, watch } = makeWorkspace();
    const sub = svc.subscribe();
    sub.setWatchedPaths(['.']);
    const events = collect(sub);

    watch.fire('a.ts', 'created');
    watch.fire('b.ts', 'modified');
    watch.fire('c.ts', 'deleted');
    vi.advanceTimersByTime(200);

    expect(events).toHaveLength(1);
    expect(events[0]?.coalesced_window_ms).toBe(200);
    expect(events[0]?.changes).toHaveLength(3);
  });

  it('marks the event truncated when the window overflows', () => {
    const { svc, watch } = makeWorkspace();
    const sub = svc.subscribe();
    sub.setWatchedPaths(['.']);
    const events = collect(sub);

    for (let i = 0; i < 501; i++) watch.fire(`f${i}.ts`, 'created');
    vi.advanceTimersByTime(200);

    expect(events).toHaveLength(1);
    expect(events[0]?.truncated).toBe(true);
    expect(events[0]?.changes).toEqual([]);
    expect(events[0]?.count).toBe(501);
  });

  it('filters out `.gitignore`d paths once loaded', async () => {
    const { svc, watch } = makeWorkspace('dist/\n');
    const sub = svc.subscribe();
    sub.setWatchedPaths(['.']);
    const events = collect(sub);
    await Promise.resolve();
    await Promise.resolve();

    watch.fire('dist/x.js', 'created');
    watch.fire('src/keep.ts', 'created');
    vi.advanceTimersByTime(200);

    expect(events).toHaveLength(1);
    expect(events[0]?.changes.map((c) => c.path)).toEqual(['src/keep.ts']);
  });

  it('rejects paths that escape the workspace', () => {
    const { svc } = makeWorkspace();
    const sub = svc.subscribe();
    expect(() => sub.setWatchedPaths(['../x'])).toThrowError(/escapes workspace|rejected/);
    expect(() => sub.setWatchedPaths(['/abs'])).toThrowError(/rejected/);
  });

  it('disposes the os handle when the last watched path set becomes empty', () => {
    const { svc, watch } = makeWorkspace();
    const sub = svc.subscribe();
    sub.setWatchedPaths(['src']);
    expect(watch.disposedCount()).toBe(0);
    sub.setWatchedPaths([]);
    expect(watch.disposedCount()).toBe(1);
  });

  it('does not fire after the service is disposed', () => {
    const { svc, watch } = makeWorkspace();
    const sub = svc.subscribe();
    sub.setWatchedPaths(['.']);
    const events = collect(sub);
    watch.fire('a.ts', 'created');
    (svc as unknown as { dispose: () => void }).dispose();
    vi.advanceTimersByTime(200);
    expect(events).toHaveLength(0);
  });

  // Phase-4 behavior contract: two sessions of one workspace share the
  // handler's single os watch — subscriptions fan out, they never hang a
  // second watcher.
  it('shares one os watch across subscriptions and fans events out per subscription', () => {
    const { svc, watch } = makeWorkspace();
    const subA = svc.subscribe();
    const subB = svc.subscribe();
    subA.setWatchedPaths(['src']);
    subB.setWatchedPaths(['lib']);
    subB.setWatchedPaths(['lib', 'src']);
    const eventsA = collect(subA);
    const eventsB = collect(subB);

    expect(watch.watchCalls).toEqual([WORK_DIR]);

    watch.fire('src/a.ts', 'created');
    watch.fire('lib/b.ts', 'modified');
    watch.fire('other/c.ts', 'deleted');
    vi.advanceTimersByTime(200);

    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]?.changes).toEqual([{ path: 'src/a.ts', change: 'created', kind: 'file' }]);
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0]?.changes).toHaveLength(2);
  });

  it('keeps the shared os watch alive while any subscription still watches', () => {
    const { svc, watch } = makeWorkspace();
    const subA = svc.subscribe();
    const subB = svc.subscribe();
    subA.setWatchedPaths(['src']);
    subB.setWatchedPaths(['lib']);
    expect(watch.watchCalls).toEqual([WORK_DIR]);

    subA.setWatchedPaths([]);
    expect(watch.disposedCount()).toBe(0);

    subB.dispose();
    expect(watch.disposedCount()).toBe(1);
  });

  it('gives each subscription its own truncation counters', () => {
    const { svc, watch } = makeWorkspace();
    const subA = svc.subscribe();
    const subB = svc.subscribe();
    subA.setWatchedPaths(['.']);
    subB.setWatchedPaths(['.']);
    const eventsA = collect(subA);
    const eventsB = collect(subB);

    for (let i = 0; i < 501; i++) watch.fire(`f${i}.ts`, 'created');
    vi.advanceTimersByTime(200);

    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    expect(eventsA[0]?.truncated).toBe(true);
    expect(eventsB[0]?.truncated).toBe(true);
  });
});
