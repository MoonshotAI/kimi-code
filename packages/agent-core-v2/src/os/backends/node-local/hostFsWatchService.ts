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
 * spawn. The signal leg owns its recovery: a native error (including sync
 * creation failure) fires one root-level invalidation and re-arms the native
 * watch with capped exponential backoff, so a transient failure neither
 * downgrades the consumer to the per-node watcher nor silently ends hot
 * reload; chokidar serves only when the platform has no recursive
 * `fs.watch`. Event mapping lives in `NativeSignalMapper` as pure logic
 * with the stat call injected, so it is testable off darwin/win32.
 * Bound at App scope.
 */

import { watch as fsWatch, lstatSync, type FSWatcher as NodeFSWatcher } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';

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

const NATIVE_RETRY_BASE_MS = 1000;
const NATIVE_RETRY_MAX_MS = 30000;

export interface NativeSignalStat {
  kindOf(absPath: string): HostFsChangeKind | undefined;
}

export class NativeSignalMapper {
  private readonly knownKinds = new Map<string, HostFsChangeKind>();

  constructor(private readonly stat: NativeSignalStat) {}

  map(
    root: string,
    eventType: string,
    filename: string | null,
    ignored: (path: string) => boolean,
  ): HostFsChange | undefined {
    const absPath = this.resolveEventPath(root, filename);
    if (absPath !== root && ignored(absPath)) return undefined;
    if (eventType === 'change') {
      return { path: absPath, action: 'modified', kind: this.knownKinds.get(absPath) ?? 'file' };
    }
    if (eventType !== 'rename') return undefined;
    const statKind = this.stat.kindOf(absPath);
    if (statKind !== undefined) {
      const action: HostFsChangeAction = this.knownKinds.has(absPath) ? 'modified' : 'created';
      this.knownKinds.set(absPath, statKind);
      return { path: absPath, action, kind: statKind };
    }
    const kind = this.knownKinds.get(absPath) ?? 'file';
    this.knownKinds.delete(absPath);
    return { path: absPath, action: 'deleted', kind };
  }

  private resolveEventPath(root: string, filename: string | null): string {
    if (filename === null || filename === '') return root;
    if (isAbsolute(filename)) return clampToRoot(root, filename);
    if (filename === basename(root) && this.stat.kindOf(join(root, filename)) === undefined) {
      return root;
    }
    return join(root, filename);
  }
}

function clampToRoot(root: string, absPath: string): string {
  const rel = relative(root, absPath);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return absPath;
  return root;
}

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

class SignalWatchHandle implements IHostFsWatchHandle {
  readonly onDidChange: Event<HostFsChange>;

  private readonly emitter: Emitter<HostFsChange>;
  private readonly ignored: (path: string) => boolean;
  private readonly mapper = new NativeSignalMapper({
    kindOf: (absPath) => {
      try {
        return lstatSync(absPath).isDirectory() ? 'directory' : 'file';
      } catch {
        return undefined;
      }
    },
  });
  private nativeWatcher: NodeFSWatcher | undefined;
  private chokidarLeg: HostFsWatchHandle | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempts = 0;
  private disposed = false;

  constructor(private readonly root: string, options: HostFsWatchOptions | undefined) {
    this.emitter = new Emitter<HostFsChange>();
    this.onDidChange = this.emitter.event;
    this.ignored = options?.ignored ?? DEFAULT_IGNORED;
    this.startNativeLeg();
  }

  private startNativeLeg(): void {
    if (this.disposed) return;
    try {
      const watcher = fsWatch(
        this.root,
        { persistent: false, recursive: true },
        (eventType, filename) => {
          if (this.disposed) return;
          const mapped = this.mapper.map(this.root, eventType, filename, this.ignored);
          if (mapped !== undefined) this.emitter.fire(mapped);
        },
      );
      watcher.on('error', (error: NodeJS.ErrnoException) => {
        this.onNativeError(error);
      });
      this.nativeWatcher = watcher;
      this.retryAttempts = 0;
    } catch (error) {
      this.onNativeError(error as NodeJS.ErrnoException);
    }
  }

  private onNativeError(error: NodeJS.ErrnoException): void {
    if (this.disposed) return;
    this.nativeWatcher?.close();
    this.nativeWatcher = undefined;
    if (error.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
      this.startChokidarLeg();
      return;
    }
    onUnexpectedError(error);
    this.emitter.fire({ path: this.root, action: 'modified', kind: 'directory' });
    const delay = Math.min(NATIVE_RETRY_BASE_MS * 2 ** this.retryAttempts, NATIVE_RETRY_MAX_MS);
    this.retryAttempts += 1;
    this.retryTimer = setTimeout(() => {
      this.startNativeLeg();
    }, delay);
    this.retryTimer.unref?.();
  }

  private startChokidarLeg(): void {
    if (this.chokidarLeg !== undefined) return;
    const leg = new HostFsWatchHandle(this.root, { recursive: true, ignored: this.ignored });
    leg.onDidChange((event) => {
      if (!this.disposed) this.emitter.fire(event);
    });
    this.chokidarLeg = leg;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.nativeWatcher?.close();
    this.chokidarLeg?.dispose();
    this.emitter.dispose();
  }
}

export class HostFsWatchService implements IHostFsWatchService {
  declare readonly _serviceBrand: undefined;

  watch(path: string, options?: HostFsWatchOptions): IHostFsWatchHandle {
    if (useNativeRecursive(options)) {
      return new SignalWatchHandle(path, options);
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
