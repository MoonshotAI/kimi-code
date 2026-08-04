/**
 * `hostFsWatch` domain — `IHostFsWatchService` implementation.
 *
 * Wraps `chokidar` to report raw create/modify/delete events under an absolute
 * path. Each `watch()` call owns an independent watcher; disposing the handle
 * closes it. A `signal`-mode recursive watch on darwin/win32 instead uses ONE
 * native recursive `fs.watch` (FSEvents / ReadDirectoryChangesW), whose fd
 * footprint stays constant in the subtree size — chokidar holds one
 * `fs.watch` fd per file and per directory on macOS, so per-node watching of
 * a fat subtree can exhaust the process fd budget and break every subsequent
 * spawn. Bound at App scope.
 */

import { watch as fsWatch, lstatSync, type FSWatcher as NodeFSWatcher } from 'node:fs';
import { join } from 'node:path';

import { FSWatcher } from 'chokidar';

import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';

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
  readonly onDidChange: Event<HostFsChange>;

  private readonly emitter: Emitter<HostFsChange>;
  private readonly watcher: FSWatcher;
  private disposed = false;

  constructor(path: string, options: HostFsWatchOptions | undefined) {
    this.emitter = new Emitter<HostFsChange>();
    this.onDidChange = this.emitter.event;
    this.watcher = new FSWatcher({
      ignoreInitial: true,
      persistent: false,
      followSymlinks: false,
      depth: options?.recursive === false ? 0 : undefined,
      ignored: options?.ignored ?? DEFAULT_IGNORED,
    });
    this.watcher.on('all', (eventName: string, absPath: string) => {
      const mapped = mapChokidarEvent(eventName, absPath);
      if (mapped !== undefined) this.emitter.fire(mapped);
    });
    this.watcher.on('error', (error: unknown) => {
      onUnexpectedError(error);
    });
    this.watcher.add(path);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.watcher.close().catch(() => undefined);
    this.emitter.dispose();
  }
}

class NativeRecursiveWatchHandle implements IHostFsWatchHandle {
  readonly onDidChange: Event<HostFsChange>;

  private readonly emitter: Emitter<HostFsChange>;
  private readonly watcher: NodeFSWatcher;
  private readonly ignored: (path: string) => boolean;
  private readonly knownKinds = new Map<string, HostFsChangeKind>();
  private disposed = false;

  constructor(path: string, options: HostFsWatchOptions | undefined) {
    this.emitter = new Emitter<HostFsChange>();
    this.onDidChange = this.emitter.event;
    this.ignored = options?.ignored ?? DEFAULT_IGNORED;
    this.watcher = fsWatch(path, { persistent: false, recursive: true }, (eventType, filename) => {
      this.onNativeEvent(path, eventType, filename);
    });
    this.watcher.on('error', (error: unknown) => {
      onUnexpectedError(error);
    });
  }

  private onNativeEvent(root: string, eventType: string, filename: string | null): void {
    if (this.disposed) return;
    const absPath = filename === null || filename === '' ? root : join(root, filename);
    if (absPath !== root && this.ignored(absPath)) return;
    const mapped = this.mapNativeEvent(absPath, eventType);
    if (mapped !== undefined) this.emitter.fire(mapped);
  }

  private mapNativeEvent(absPath: string, eventType: string): HostFsChange | undefined {
    if (eventType === 'change') {
      return { path: absPath, action: 'modified', kind: this.knownKinds.get(absPath) ?? 'file' };
    }
    if (eventType !== 'rename') return undefined;
    try {
      const kind: HostFsChangeKind = lstatSync(absPath).isDirectory() ? 'directory' : 'file';
      const action: HostFsChangeAction = this.knownKinds.has(absPath) ? 'modified' : 'created';
      this.knownKinds.set(absPath, kind);
      return { path: absPath, action, kind };
    } catch {
      const kind: HostFsChangeKind = this.knownKinds.get(absPath) ?? 'file';
      this.knownKinds.delete(absPath);
      return { path: absPath, action: 'deleted', kind };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.watcher.close();
    this.emitter.dispose();
  }
}

export class HostFsWatchService implements IHostFsWatchService {
  declare readonly _serviceBrand: undefined;

  watch(path: string, options?: HostFsWatchOptions): IHostFsWatchHandle {
    if (useNativeRecursive(options)) {
      const native = tryNativeRecursiveWatch(path, options);
      if (native !== undefined) return native;
    }
    return new HostFsWatchHandle(path, options);
  }
}

function useNativeRecursive(options: HostFsWatchOptions | undefined): boolean {
  return (
    options?.signal === true &&
    options.recursive !== false &&
    (process.platform === 'darwin' || process.platform === 'win32')
  );
}

function tryNativeRecursiveWatch(
  path: string,
  options: HostFsWatchOptions | undefined,
): IHostFsWatchHandle | undefined {
  try {
    return new NativeRecursiveWatchHandle(path, options);
  } catch {
    return undefined;
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
  ScopeActivation.OnScopeCreated,
  'hostFsWatch',
);
