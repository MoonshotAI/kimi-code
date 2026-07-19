/**
 * `sessionFs` test stubs — controllable multi-handle fake host watcher.
 *
 * `fakeHostFsWatch()` mirrors `IHostFsWatchService.watch()` semantics (one
 * independent handle per call) without touching the real filesystem: tests
 * fire synthetic changes at a chosen handle and advance the debounce window
 * with fake timers. Import from a relative path (`./stubs` or
 * `../sessionFs/stubs`).
 */

import { join } from 'node:path';

import {
  type HostFsChange,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

export interface FakeWatchHandle {
  readonly root: string;
  fire: (rel: string, action: HostFsChange['action'], kind?: HostFsChange['kind']) => void;
  readonly disposed: () => boolean;
}

export interface FakeWatch {
  readonly service: IHostFsWatchService;
  readonly watchCalls: string[];
  readonly handles: FakeWatchHandle[];
  fire: (rel: string, action: HostFsChange['action'], kind?: HostFsChange['kind']) => void;
  readonly disposed: () => boolean;
}

export function fakeHostFsWatch(): FakeWatch {
  const watchCalls: string[] = [];
  const handles: FakeWatchHandle[] = [];
  const service: IHostFsWatchService = {
    _serviceBrand: undefined,
    watch: (path) => {
      watchCalls.push(path);
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
      handles.push({
        root: path,
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
    handles,
    fire: (rel, action, kind = 'file') => handles.at(-1)?.fire(rel, action, kind),
    disposed: () => handles.every((h) => h.disposed()),
  };
}
