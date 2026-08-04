/**
 * `os` test stubs — shared `IHostFsWatchService` fake for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or `../os/stubs`).
 * The fake records watched paths/options and routes synthetic change events
 * through the recursive and ignored topology of each handle.
 */

import { Emitter } from '#/_base/event';
import {
  type HostFsChange,
  type HostFsWatchOptions,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

export interface StubHostFsWatch extends IHostFsWatchService {
  fire(path: string, change?: Partial<HostFsChange>): void;
  watchedPaths(): readonly string[];
  watchedEntries(): readonly {
    readonly path: string;
    readonly options: HostFsWatchOptions | undefined;
  }[];
}

export function stubHostFsWatch(): StubHostFsWatch {
  const watchers: Array<{
    readonly path: string;
    readonly options: HostFsWatchOptions | undefined;
    readonly emitter: Emitter<HostFsChange>;
  }> = [];
  return {
    _serviceBrand: undefined,
    watch(path: string, options?: HostFsWatchOptions): IHostFsWatchHandle {
      const emitter = new Emitter<HostFsChange>();
      const entry = { path, options, emitter };
      watchers.push(entry);
      return {
        onDidChange: emitter.event,
        dispose: () => {
          const index = watchers.indexOf(entry);
          if (index >= 0) watchers.splice(index, 1);
          emitter.dispose();
        },
      };
    },
    fire(path: string, change?: Partial<HostFsChange>): void {
      for (const watcher of watchers) {
        if (!watchReceives(watcher.path, watcher.options, path, change?.kind ?? 'file')) continue;
        watcher.emitter.fire({ path, action: 'modified', kind: 'file', ...change });
      }
    },
    watchedPaths(): readonly string[] {
      return watchers.map((watcher) => watcher.path);
    },
    watchedEntries() {
      return watchers.map(({ path, options }) => ({ path, options }));
    },
  };
}

function watchReceives(
  root: string,
  options: HostFsWatchOptions | undefined,
  changedPath: string,
  _kind: HostFsChange['kind'],
): boolean {
  if (options?.ignored?.(changedPath) === true) return false;
  if (changedPath === root) return true;
  if (!changedPath.startsWith(`${root}/`)) return false;
  const relative = changedPath.slice(root.length + 1);
  const segments = relative.split('/').filter((segment) => segment.length > 0);
  if (options?.recursive === false && segments.length > 1) return false;
  return true;
}
