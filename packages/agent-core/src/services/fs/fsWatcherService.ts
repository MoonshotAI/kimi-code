import nodePath from 'node:path';

import { FSWatcher } from 'chokidar';

import { Disposable, DisposableMap, ReferenceCollection, dispose } from '../../di';
import type { IDisposable, IReference } from '../../di';
import { ISessionService } from '../session/session';

import type {
  FsChangeAction,
  FsChangeEntry,
  FsChangeKind,
} from '@moonshot-ai/protocol';

import { ILogService } from '../logger/logger';
import {
  IFsWatcher,
  FsWatchLimitError,
  type FsChangedFrame,
  type FsWatcherConnectionLookup,
  type FsWatcherServiceOptions,
} from './fsWatcher';

const DEFAULT_DEBOUNCE_MS = 200;

const DEFAULT_MAX_CHANGES_PER_WINDOW = 500;

const DEFAULT_MAX_PATHS_PER_CONNECTION = 100;

interface PendingChange {
  absPath: string;
  action: FsChangeAction;
  kind: FsChangeKind;
}

class PathReferenceCollection extends ReferenceCollection<string> {
  private readonly activePaths = new Set<string>();

  constructor(private readonly watcher: FSWatcher) {
    super();
  }

  get size(): number {
    return this.activePaths.size;
  }

  protected createReferencedObject(absPath: string): string {
    this.watcher.add(absPath);
    this.activePaths.add(absPath);
    return absPath;
  }

  protected destroyReferencedObject(absPath: string): void {
    this.activePaths.delete(absPath);
    this.watcher.unwatch(absPath);
  }
}

class SessionEntry implements IDisposable {
  readonly pathRefs: PathReferenceCollection;
  readonly connectionPathRefs = new Map<string, Map<string, IReference<string>>>();
  pendingChanges: PendingChange[] = [];
  pendingRawCount = 0;
  truncated = false;
  debounceTimer: NodeJS.Timeout | undefined = undefined;
  seq = 0;
  private _disposed = false;

  constructor(
    public readonly sessionId: string,
    public readonly watcher: FSWatcher,
    public cwd: string,
    private readonly logger: ILogService,
  ) {
    this.pathRefs = new PathReferenceCollection(watcher);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    void this.watcher.close().catch((error) => {
      this.logger.warn(
        { sessionId: this.sessionId, err: String(error) },
        'fs-watcher close failed',
      );
    });
  }
}

export class FsWatcherService extends Disposable implements IFsWatcher {
  readonly _serviceBrand: undefined;

  private readonly debounceMs: number;
  private readonly maxChangesPerWindow: number;
  private readonly maxPathsPerConnection: number;
  private readonly makeWatcher: () => FSWatcher;
  private readonly sessions: DisposableMap<string, SessionEntry>;

  private readonly connections = new Map<
    string,
    Map<string, Map<string, IReference<string>>>
  >();

  constructor(
    private readonly lookup: FsWatcherConnectionLookup,
    options: FsWatcherServiceOptions,
    @ILogService private readonly logger: ILogService,
    @ISessionService _sessionService: ISessionService,
  ) {
    super();
    this.sessions = this._register(new DisposableMap<string, SessionEntry>());
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxChangesPerWindow =
      options.maxChangesPerWindow ?? DEFAULT_MAX_CHANGES_PER_WINDOW;
    this.maxPathsPerConnection =
      options.maxPathsPerConnection ?? DEFAULT_MAX_PATHS_PER_CONNECTION;
    this.makeWatcher =
      options.watcherFactory ??
      (() =>
        new FSWatcher({
          ignoreInitial: true,
          persistent: false,
          ignored: (p: string) => /(?:^|[/\\])\.git(?:$|[/\\])/.test(p),
        }));
  }

  addPaths(
    sessionId: string,
    connectionId: string,
    absPaths: readonly string[],
  ): readonly string[] {
    if (this._store.isDisposed) return [];

    const connSessions = this.getOrCreateConnection(connectionId);
    let existingForSession = connSessions.get(sessionId);
    const newlyAdded: string[] = [];
    let projectedTotal = this.countForConnection(connectionId);
    for (const abs of absPaths) {
      if (existingForSession?.has(abs)) continue;
      newlyAdded.push(abs);
      projectedTotal += 1;
    }
    if (projectedTotal > this.maxPathsPerConnection) {
      throw new FsWatchLimitError(
        connectionId,
        projectedTotal,
        this.maxPathsPerConnection,
      );
    }
    if (newlyAdded.length === 0) {
      return existingForSession ? Array.from(existingForSession.keys()) : [];
    }

    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = this.createSessionEntry(sessionId, deriveSharedCwd(newlyAdded));
      this.sessions.set(sessionId, entry);
    }

    if (!existingForSession) {
      existingForSession = new Map();
      connSessions.set(sessionId, existingForSession);
      entry.connectionPathRefs.set(connectionId, existingForSession);
    }
    for (const abs of newlyAdded) {
      existingForSession.set(abs, entry.pathRefs.acquire(abs));
    }
    return Array.from(existingForSession.keys());
  }

  removePaths(
    sessionId: string,
    connectionId: string,
    absPaths: readonly string[],
  ): readonly string[] {
    if (this._store.isDisposed) return [];
    const entry = this.sessions.get(sessionId);
    if (!entry) return [];
    const connSessions = this.connections.get(connectionId);
    const connSessionRefs = connSessions?.get(sessionId);
    if (!connSessionRefs) return [];

    const refsToDispose: IReference<string>[] = [];
    for (const abs of absPaths) {
      const ref = connSessionRefs.get(abs);
      if (!ref) continue;
      connSessionRefs.delete(abs);
      refsToDispose.push(ref);
    }

    try {
      dispose(refsToDispose);
    } finally {
      if (connSessionRefs.size === 0) {
        connSessions?.delete(sessionId);
        entry.connectionPathRefs.delete(connectionId);
        if (connSessions && connSessions.size === 0) {
          this.connections.delete(connectionId);
        }
      }

      if (entry.pathRefs.size === 0) {
        this.sessions.deleteAndDispose(sessionId);
      }
    }
    return connSessionRefs ? Array.from(connSessionRefs.keys()) : [];
  }

  countForConnection(connectionId: string): number {
    const m = this.connections.get(connectionId);
    if (!m) return 0;
    let total = 0;
    for (const refs of m.values()) total += refs.size;
    return total;
  }

  forgetConnection(connectionId: string): void {
    const sessionMap = this.connections.get(connectionId);
    if (!sessionMap) return;

    const entries = Array.from(sessionMap.entries());
    const removals = entries.map(([sid, refs]) => ({
      dispose: () => {
        this.removePaths(sid, connectionId, Array.from(refs.keys()));
      },
    }));
    try {
      dispose(removals);
    } finally {
      this.connections.delete(connectionId);
    }
  }

  watchedPaths(connectionId: string, sessionId: string): readonly string[] {
    const refs = this.connections.get(connectionId)?.get(sessionId);
    if (!refs) return [];
    return Array.from(refs.keys());
  }

  bindSessionCwd(sessionId: string, cwd: string): void {
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = this.createSessionEntry(sessionId, cwd);
      this.sessions.set(sessionId, entry);
      return;
    }
    if (entry.cwd !== cwd) {
      this.logger.debug(
        { sessionId, oldCwd: entry.cwd, newCwd: cwd },
        'fs-watcher cwd override',
      );
      entry.cwd = cwd;
    }
  }

  private getOrCreateConnection(
    connectionId: string,
  ): Map<string, Map<string, IReference<string>>> {
    let m = this.connections.get(connectionId);
    if (!m) {
      m = new Map();
      this.connections.set(connectionId, m);
    }
    return m;
  }

  private createSessionEntry(sessionId: string, cwd: string): SessionEntry {
    const watcher = this.makeWatcher();
    const entry = new SessionEntry(sessionId, watcher, cwd, this.logger);
    watcher.on(
      'all',
      (eventName: string, absPath: string) => {
        this.onRawChange(sessionId, entry, eventName, absPath);
      },
    );
    watcher.on('error', (err) => {
      this.logger.warn(
        { sessionId, err: String(err) },
        'fs-watcher chokidar error',
      );
    });
    return entry;
  }

  private onRawChange(
    sessionId: string,
    entry: SessionEntry,
    eventName: string,
    absPath: string,
  ): void {
    if (this._store.isDisposed) return;
    const action = mapChokidarEventToAction(eventName);
    if (action === undefined) return;
    const kind = mapChokidarEventToKind(eventName);

    entry.pendingRawCount += 1;
    if (!entry.truncated) {
      entry.pendingChanges.push({ absPath, action, kind });
      if (entry.pendingChanges.length > this.maxChangesPerWindow) {
        entry.truncated = true;
        entry.pendingChanges = [];
      }
    }

    if (entry.debounceTimer === undefined) {
      const timer = setTimeout(() => { this.flushWindow(sessionId); }, this.debounceMs);
      timer.unref?.();
      entry.debounceTimer = timer;
    }
  }

  private flushWindow(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.debounceTimer = undefined;
    if (entry.pendingRawCount === 0) return;
    const truncated = entry.truncated;
    const rawCount = entry.pendingRawCount;
    const pending = entry.pendingChanges;

    entry.pendingChanges = [];
    entry.pendingRawCount = 0;
    entry.truncated = false;

    for (const [connectionId, connPathRefs] of entry.connectionPathRefs) {
      const sink = this.lookup.resolve(connectionId);
      if (!sink) continue;
      let perConnChanges: FsChangeEntry[];
      if (truncated) {
        perConnChanges = [];
      } else {
        perConnChanges = [];
        for (const ch of pending) {
          if (!isUnderAny(ch.absPath, connPathRefs.keys())) continue;
          const relPath = toPosixRelative(entry.cwd, ch.absPath);
          perConnChanges.push({
            path: relPath,
            change: ch.action,
            kind: ch.kind,
          });
        }
        if (perConnChanges.length === 0) continue;
      }
      entry.seq += 1;
      const frame: FsChangedFrame = {
        type: 'event.fs.changed',
        seq: entry.seq,
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          changes: perConnChanges,
          coalesced_window_ms: this.debounceMs,
          ...(truncated ? { truncated: true, count: rawCount } : {}),
        },
      };
      try {
        sink.send(frame);
      } catch (error) {
        this.logger.warn(
          { connectionId, err: String(error) },
          'fs-watcher send failed',
        );
      }
    }
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    this.connections.clear();
    super.dispose();
  }
}

function mapChokidarEventToAction(name: string): FsChangeAction | undefined {
  switch (name) {
    case 'add':
    case 'addDir':
      return 'created';
    case 'change':
      return 'modified';
    case 'unlink':
    case 'unlinkDir':
      return 'deleted';
    default:
      return undefined;
  }
}

function mapChokidarEventToKind(name: string): FsChangeKind {
  switch (name) {
    case 'addDir':
    case 'unlinkDir':
      return 'directory';
    default:
      return 'file';
  }
}

function isUnderAny(absPath: string, parents: Iterable<string>): boolean {
  for (const parent of parents) {
    if (absPath === parent) return true;
    const sep = nodePath.sep;
    if (absPath.startsWith(parent + sep)) return true;
    if (sep !== '/' && absPath.startsWith(parent + '/')) return true;
  }
  return false;
}

function toPosixRelative(cwd: string, abs: string): string {
  if (abs === cwd) return '.';
  const rel = nodePath.relative(cwd, abs);
  if (rel === '') return '.';
  return rel.split(nodePath.sep).join('/');
}

function deriveSharedCwd(absPaths: readonly string[]): string {
  if (absPaths.length === 0) return '/';
  if (absPaths.length === 1) return nodePath.dirname(absPaths[0]!);

  let prefix = absPaths[0]!.split(nodePath.sep);
  for (let i = 1; i < absPaths.length; i++) {
    const segs = absPaths[i]!.split(nodePath.sep);
    let j = 0;
    while (j < prefix.length && j < segs.length && prefix[j] === segs[j]) j++;
    prefix = prefix.slice(0, j);
  }
  return prefix.length === 0 ? '/' : prefix.join(nodePath.sep) || nodePath.sep;
}
