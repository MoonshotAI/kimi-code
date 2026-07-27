/**
 * `sessionFs` test stubs — controllable fake host watcher and stat-counting
 * host filesystem.
 *
 * `fakeHostFsWatch()` mirrors `IHostFsWatchService.watch()` semantics (one
 * independent handle per call) without touching the real filesystem: tests
 * fire synthetic changes at the most recent handle and advance the debounce
 * window with fake timers. `countingHostFs()` wraps a real `HostFileSystem`
 * and counts `stat` calls, optionally failing chosen paths with `EACCES`.
 * Import from a relative path (`./stubs` or `../sessionFs/stubs`).
 */

import { join } from 'node:path';

import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  type HostFsChange,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

export interface FakeWatch {
  readonly service: IHostFsWatchService;
  readonly watchCalls: string[];
  fire: (rel: string, action: HostFsChange['action'], kind?: HostFsChange['kind']) => void;
  readonly disposed: () => boolean;
}

export function fakeHostFsWatch(): FakeWatch {
  const watchCalls: string[] = [];
  const handles: Array<{
    fire: (rel: string, action: HostFsChange['action'], kind?: HostFsChange['kind']) => void;
    disposed: () => boolean;
  }> = [];
  const service: IHostFsWatchService = {
    _serviceBrand: undefined,
    watch: (path) => {
      watchCalls.push(path);
      let listener: ((e: HostFsChange) => void) | undefined;
      let disposed = false;
      const handle: IHostFsWatchHandle = {
        ready: Promise.resolve(),
        onDidChange: (l) => {
          listener = l;
          return { dispose: () => (listener = undefined) };
        },
        dispose: () => {
          disposed = true;
          listener = undefined;
        },
      };
      handles.push({
        fire: (rel, action, kind = 'file') =>
          listener?.({ path: join(path, rel), action, kind }),
        disposed: () => disposed,
      });
      return handle;
    },
  };
  return {
    service,
    watchCalls,
    fire: (rel, action, kind = 'file') => handles.at(-1)?.fire(rel, action, kind),
    disposed: () => handles.every((h) => h.disposed()),
  };
}

export function countingHostFs(poisonedPaths?: Set<string>): {
  fs: IHostFileSystem;
  statCalls: () => number;
} {
  const real = new HostFileSystem();
  let count = 0;
  const fs = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'stat') {
        return async (path: string) => {
          count += 1;
          if (poisonedPaths?.has(path)) {
            const err = new Error(`EACCES: permission denied, stat '${path}'`) as NodeJS.ErrnoException;
            err.code = 'EACCES';
            throw err;
          }
          return target.stat(path);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as IHostFileSystem;
  return { fs, statCalls: () => count };
}
