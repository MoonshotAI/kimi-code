/**
 * `hostFsWatch` domain — `IHostFsWatchService` implementation.
 *
 * Reports precise or coarse host filesystem changes through platform
 * watchers. Each handle owns and disposes its watcher. Bound at App scope.
 */

import { watch as fsWatch } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';

import { FSWatcher } from 'chokidar';

import type { IDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
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

interface NativeFsWatcher {
  close(): void;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): this;
}

interface HostFsWatchRuntime {
  readonly platform: NodeJS.Platform;
  watchNative(
    root: string,
    listener: (eventType: string, filename: string | null) => void,
  ): NativeFsWatcher;
  scheduleRetry(callback: () => void, delayMs: number): IDisposable;
}

const NODE_HOST_FS_WATCH_RUNTIME: HostFsWatchRuntime = {
  platform: process.platform,
  watchNative: (root, listener) =>
    fsWatch(root, { persistent: false, recursive: true }, listener),
  scheduleRetry: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return {
      dispose: () => {
        clearTimeout(timer);
      },
    };
  },
};

interface WatchReadiness {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function createWatchReadiness(): WatchReadiness {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

class HostFsWatchHandle implements IHostFsWatchHandle {
  readonly ready: Promise<void>;
  readonly onDidChange: Event<HostFsChange>;

  private readonly readiness = createWatchReadiness();
  private readonly emitter: Emitter<HostFsChange>;
  private readonly watcher: FSWatcher;
  private disposed = false;

  constructor(path: string, options: HostFsWatchOptions | undefined) {
    this.ready = this.readiness.promise;
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
      this.readiness.reject(error);
      onUnexpectedError(error);
    });
    this.watcher.once('ready', () => this.readiness.resolve());
    this.watcher.add(path);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readiness.resolve();
    void this.watcher.close().catch(() => undefined);
    this.emitter.dispose();
  }
}

class SignalWatchHandle implements IHostFsWatchHandle {
  readonly ready: Promise<void>;
  readonly onDidChange: Event<HostFsChange>;

  private readonly readiness = createWatchReadiness();
  private readonly emitter: Emitter<HostFsChange>;
  private readonly ignored: (path: string) => boolean;
  private nativeWatcher: NativeFsWatcher | undefined;
  private chokidarLeg: HostFsWatchHandle | undefined;
  private retry: IDisposable | undefined;
  private retryAttempts = 0;
  private recovering = false;
  private disposed = false;

  constructor(
    private readonly root: string,
    options: HostFsWatchOptions | undefined,
    private readonly runtime: HostFsWatchRuntime,
  ) {
    this.ready = this.readiness.promise;
    this.emitter = new Emitter<HostFsChange>();
    this.onDidChange = this.emitter.event;
    this.ignored = options?.ignored ?? DEFAULT_IGNORED;
    this.startNativeLeg();
  }

  private startNativeLeg(): void {
    if (this.disposed) return;
    try {
      const watcher = this.runtime.watchNative(this.root, (_eventType, filename) => {
        if (this.disposed) return;
        this.retryAttempts = 0;
        const absPath = resolveNativeSignalPath(this.root, filename);
        if (absPath !== this.root && this.ignored(absPath)) return;
        this.fireInvalidation();
      });
      watcher.on('error', (error: NodeJS.ErrnoException) => {
        this.onNativeError(watcher, error);
      });
      this.nativeWatcher = watcher;
      this.readiness.resolve();
      if (this.recovering) {
        this.recovering = false;
        this.fireInvalidation();
      }
    } catch (error) {
      this.onNativeError(undefined, error as NodeJS.ErrnoException);
    }
  }

  private onNativeError(watcher: NativeFsWatcher | undefined, error: NodeJS.ErrnoException): void {
    if (this.disposed) return;
    if (watcher !== undefined && watcher !== this.nativeWatcher) return;
    watcher?.close();
    this.nativeWatcher = undefined;
    if (error.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') {
      this.recovering = false;
      this.startChokidarLeg();
      this.fireInvalidation();
      return;
    }
    onUnexpectedError(error);
    this.recovering = true;
    this.fireInvalidation();
    const delay = Math.min(NATIVE_RETRY_BASE_MS * 2 ** this.retryAttempts, NATIVE_RETRY_MAX_MS);
    this.retryAttempts += 1;
    this.retry?.dispose();
    this.retry = this.runtime.scheduleRetry(() => {
      this.retry = undefined;
      this.startNativeLeg();
    }, delay);
  }

  private startChokidarLeg(): void {
    if (this.chokidarLeg !== undefined) return;
    const leg = new HostFsWatchHandle(this.root, { recursive: true, ignored: this.ignored });
    leg.onDidChange((event) => {
      if (!this.disposed) this.emitter.fire(event);
    });
    void leg.ready.then(
      () => this.readiness.resolve(),
      (error: unknown) => this.readiness.reject(error),
    );
    this.chokidarLeg = leg;
  }

  private fireInvalidation(): void {
    this.emitter.fire({ path: this.root, action: 'modified', kind: 'directory' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readiness.resolve();
    this.retry?.dispose();
    this.nativeWatcher?.close();
    this.chokidarLeg?.dispose();
    this.emitter.dispose();
  }
}

export class HostFsWatchService implements IHostFsWatchService {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly runtime: HostFsWatchRuntime = NODE_HOST_FS_WATCH_RUNTIME) {}

  watch(path: string, options?: HostFsWatchOptions): IHostFsWatchHandle {
    if (useNativeRecursive(options, this.runtime.platform)) {
      return new SignalWatchHandle(path, options, this.runtime);
    }
    return new HostFsWatchHandle(path, options);
  }
}

function useNativeRecursive(
  options: HostFsWatchOptions | undefined,
  platform: NodeJS.Platform,
): boolean {
  return (
    options?.signal === true &&
    options.recursive !== false &&
    (platform === 'darwin' || platform === 'win32')
  );
}

function resolveNativeSignalPath(root: string, filename: string | null): string {
  if (filename === null || filename === '' || filename === basename(root)) return root;
  return clampToRoot(root, isAbsolute(filename) ? filename : join(root, filename));
}

function clampToRoot(root: string, absPath: string): string {
  const rel = relative(root, absPath);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return absPath;
  return root;
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
