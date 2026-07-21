/**
 * `hostFsWatch` domain (L1) — `IHostFsWatchService` implementation.
 *
 * Wraps `chokidar` to report raw create/modify/delete events under an absolute
 * path. Each `watch()` call owns an independent `FSWatcher`; disposing the
 * handle closes it. Bound at App scope.
 */

import { FSWatcher } from 'chokidar';

import { Emitter, type Event } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { isSpecialFileStat } from '#/_base/utils/fs';

import {
  type HostFsChange,
  type HostFsChangeAction,
  type HostFsChangeKind,
  type HostFsWatchOptions,
  type IHostFsWatchHandle,
  IHostFsWatchService,
} from '#/os/interface/hostFsWatch';

const DEFAULT_IGNORED = (p: string): boolean => /(?:^|[/\\])\.git(?:$|[/\\])/.test(p);

class HostFsWatchHandle implements IHostFsWatchHandle {
  readonly ready: Promise<void>;
  readonly onDidChange: Event<HostFsChange>;

  private readonly emitter: Emitter<HostFsChange>;
  private readonly watcher: FSWatcher;
  private disposed = false;
  private readySettled = false;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;

  constructor(path: string, options: HostFsWatchOptions | undefined) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch(() => undefined);
    this.emitter = new Emitter<HostFsChange>();
    this.onDidChange = this.emitter.event;
    this.watcher = new FSWatcher({
      ignoreInitial: true,
      persistent: false,
      followSymlinks: false,
      depth: options?.recursive === false ? 0 : undefined,
      ignored: (path, stats) =>
        isSpecialFileStat(stats) || (options?.ignored?.(path) ?? DEFAULT_IGNORED(path)),
    });
    this.watcher.on('all', (eventName: string, absPath: string) => {
      if (this.disposed) return;
      const mapped = mapChokidarEvent(eventName, absPath);
      if (mapped !== undefined) this.emitter.fire(mapped);
    });
    this.watcher.on('error', (error: unknown) => {
      if (!this.readySettled) {
        this.readySettled = true;
        this.rejectReady(error);
      }
      onUnexpectedError(error);
    });
    this.watcher.on('ready', () => {
      if (this.readySettled) return;
      this.readySettled = true;
      this.resolveReady();
    });
    this.watcher.add(path);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.readySettled) {
      this.readySettled = true;
      this.resolveReady();
    }
    void this.watcher.close().catch(() => undefined);
    this.emitter.dispose();
  }
}

export class HostFsWatchService implements IHostFsWatchService {
  declare readonly _serviceBrand: undefined;

  watch(path: string, options?: HostFsWatchOptions): IHostFsWatchHandle {
    return new HostFsWatchHandle(path, options);
  }
}

function mapChokidarEvent(eventName: string, absPath: string): HostFsChange | undefined {
  const mapped = mapActionAndKind(eventName);
  if (mapped === undefined) return undefined;
  return { path: absPath, action: mapped.action, kind: mapped.kind };
}

function mapActionAndKind(
  eventName: string,
): { action: HostFsChangeAction; kind: HostFsChangeKind } | undefined {
  switch (eventName) {
    case 'add':
      return { action: 'created', kind: 'file' };
    case 'addDir':
      return { action: 'created', kind: 'directory' };
    case 'change':
      return { action: 'modified', kind: 'file' };
    case 'unlink':
      return { action: 'deleted', kind: 'file' };
    case 'unlinkDir':
      return { action: 'deleted', kind: 'directory' };
    default:
      return undefined;
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostFsWatchService,
  HostFsWatchService,
  InstantiationType.Eager,
  'hostFsWatch',
);
