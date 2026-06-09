/**
 * `FsWatcherService` — implementation of `IFsWatcher`.
 */

import nodePath from 'node:path';

import { FSWatcher } from 'chokidar';

import { Disposable } from '@moonshot-ai/agent-core';
import { ISessionService } from '@moonshot-ai/services';

import type { FsChangeEntry, FsChangeAction, FsChangeKind } from '@moonshot-ai/protocol';

import { ILogService } from '#/services/logger';
import {
  IFsWatcher,
  FsWatchLimitError,
  type FsChangedFrame,
  type FsWatcherConnectionLookup,
  type FsWatcherServiceOptions,
} from './fsWatcher';

/** WS.md §4.9 — 200ms coalesce window. */
const DEFAULT_DEBOUNCE_MS = 200;

/**
 * When a single window collects more than this many raw change events, we
 * flip to `truncated:true` mode and stop accumulating
 * per-entry detail. The client is expected to throw away local fs state
 * and re-`:list` to resync. WS.md §4.9 mentions "单窗口 changes 超 500
 * 时 true" — 500 is the spec threshold.
 */
const DEFAULT_MAX_CHANGES_PER_WINDOW = 500;

/** Per-connection total watched-path cap. */
const DEFAULT_MAX_PATHS_PER_CONNECTION = 100;

interface PendingChange {
  /** Absolute path of the affected entry. */
  absPath: string;
  action: FsChangeAction;
  kind: FsChangeKind;
}

interface SessionEntry {
  /** Live chokidar watcher; closed + dropped on last unref. */
  watcher: FSWatcher;
  /** `sessionId.cwd` (absolute, post-realpath) for relative-path mapping. */
  cwd: string;
  /** `absPath → refCount` across all connections subscribed to this session. */
  pathRefs: Map<string, number>;
  /** `connectionId → Set<absPath>` for overlap filtering on emit. */
  connectionPaths: Map<string, Set<string>>;
  /** Accumulating changes for the current 200ms window. */
  pendingChanges: PendingChange[];
  /** Raw event count (used for `truncated.count`). */
  pendingRawCount: number;
  /** True once `pendingChanges.length > maxChangesPerWindow`. */
  truncated: boolean;
  /** Timer for the active debounce window; `undefined` between windows. */
  debounceTimer: NodeJS.Timeout | undefined;
  /** Per-session seq counter, monotonic, starts at 1. */
  seq: number;
}

export class FsWatcherService extends Disposable implements IFsWatcher {
  readonly _serviceBrand: undefined;

  private readonly debounceMs: number;
  private readonly maxChangesPerWindow: number;
  private readonly maxPathsPerConnection: number;
  private readonly makeWatcher: () => FSWatcher;
  private readonly sessions = new Map<string, SessionEntry>();
  /** `connectionId → Map<sessionId, Set<absPath>>`. */
  private readonly connections = new Map<string, Map<string, Set<string>>>();

  constructor(
    // VSCode-style static-first / services-last. `lookup` is a closure
    // built at start.ts so it stays a positional static dep;
    // `options` is the config bag. `logger` + `_sessionService` are
    // auto-injected via @ILogService / @ISessionService. The
    // `_sessionService` parameter is intentionally unused (reserved to
    // lock construction order so IFsWatcher disposes BEFORE
    // ISessionService — see field doc above) — the leading underscore
    // keeps the linter quiet.
    private readonly lookup: FsWatcherConnectionLookup,
    options: FsWatcherServiceOptions,
    @ILogService private readonly logger: ILogService,
    @ISessionService _sessionService: ISessionService,
  ) {
    super();
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
          // WS.md §4.9: filter `.git/` noise. Regex matches a `.git` segment
          // anywhere in the absolute path.
          ignored: (p: string) => /(?:^|[/\\])\.git(?:$|[/\\])/.test(p),
        }));
  }

  addPaths(
    sessionId: string,
    connectionId: string,
    absPaths: readonly string[],
  ): readonly string[] {
    if (this._isDisposed) return [];

    // Project the new total for this connection (assuming all `absPaths` are
    // additions). Dedup against existing first.
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
      // Nothing to do; return current set.
      return existingForSession ? Array.from(existingForSession) : [];
    }

    // Lazy-create session entry. cwd is best-effort: we trust the caller
    // resolved absPaths against the session's real cwd, so any one of
    // the absPaths' shared prefix would do — but we don't have the cwd
    // in hand here. The caller is expected to pre-call
    // `bindSessionCwd` (see `_bindCwd` below) OR the lookup callback
    // will pass it on first add. We use the longest absolute-path
    // segment that is a prefix of all absPaths; failing that, fall back
    // to the first absPath's dirname. This is only used for
    // wire-path conversion at emit time and the WS handler will
    // override via `bindSessionCwd` before any emit can happen.
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = this.createSessionEntry(sessionId, deriveSharedCwd(newlyAdded));
      this.sessions.set(sessionId, entry);
    }

    if (!existingForSession) {
      existingForSession = new Set();
      connSessions.set(sessionId, existingForSession);
    }
    const adds: string[] = [];
    for (const abs of newlyAdded) {
      existingForSession.add(abs);
      const ref = entry.pathRefs.get(abs) ?? 0;
      entry.pathRefs.set(abs, ref + 1);
      // Add to chokidar only on first refcount.
      if (ref === 0) {
        adds.push(abs);
      }
      // Always tracked in per-connection set.
      let cps = entry.connectionPaths.get(connectionId);
      if (!cps) {
        cps = new Set();
        entry.connectionPaths.set(connectionId, cps);
      }
      cps.add(abs);
    }
    if (adds.length > 0) {
      entry.watcher.add(adds);
    }
    return Array.from(existingForSession);
  }

  removePaths(
    sessionId: string,
    connectionId: string,
    absPaths: readonly string[],
  ): readonly string[] {
    if (this._isDisposed) return [];
    const entry = this.sessions.get(sessionId);
    if (!entry) return [];
    const connSessions = this.connections.get(connectionId);
    const connSessionPaths = connSessions?.get(sessionId);
    if (!connSessionPaths) return [];

    const unwatch: string[] = [];
    for (const abs of absPaths) {
      if (!connSessionPaths.has(abs)) continue;
      connSessionPaths.delete(abs);
      const cps = entry.connectionPaths.get(connectionId);
      cps?.delete(abs);
      if (cps && cps.size === 0) entry.connectionPaths.delete(connectionId);
      const ref = (entry.pathRefs.get(abs) ?? 1) - 1;
      if (ref <= 0) {
        entry.pathRefs.delete(abs);
        unwatch.push(abs);
      } else {
        entry.pathRefs.set(abs, ref);
      }
    }
    if (unwatch.length > 0) {
      entry.watcher.unwatch(unwatch);
    }
    // Per-connection cleanup.
    if (connSessionPaths.size === 0) {
      connSessions?.delete(sessionId);
      if (connSessions && connSessions.size === 0) {
        this.connections.delete(connectionId);
      }
    }
    // Per-session cleanup: if no path references remain, close the watcher.
    if (entry.pathRefs.size === 0) {
      this.disposeSessionEntry(sessionId, entry);
    }
    return connSessionPaths ? Array.from(connSessionPaths) : [];
  }

  countForConnection(connectionId: string): number {
    const m = this.connections.get(connectionId);
    if (!m) return 0;
    let total = 0;
    for (const set of m.values()) total += set.size;
    return total;
  }

  forgetConnection(connectionId: string): void {
    const sessionMap = this.connections.get(connectionId);
    if (!sessionMap) return;
    // Snapshot to avoid mutation-during-iteration.
    const entries = Array.from(sessionMap.entries());
    for (const [sid, paths] of entries) {
      this.removePaths(sid, connectionId, Array.from(paths));
    }
    this.connections.delete(connectionId);
  }

  watchedPaths(connectionId: string, sessionId: string): readonly string[] {
    const set = this.connections.get(connectionId)?.get(sessionId);
    if (!set) return [];
    return Array.from(set);
  }

  /**
   * WS adapter calls this AFTER resolving the session's cwd so the
   * watcher can map absolute → POSIX-relative paths on emit. Idempotent —
   * subsequent calls with a different cwd overwrite (which would be a bug
   * but we log + accept).
   */
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

  /* ------------------------------------------------------------- internals */

  private getOrCreateConnection(
    connectionId: string,
  ): Map<string, Set<string>> {
    let m = this.connections.get(connectionId);
    if (!m) {
      m = new Map();
      this.connections.set(connectionId, m);
    }
    return m;
  }

  private createSessionEntry(sessionId: string, cwd: string): SessionEntry {
    const watcher = this.makeWatcher();
    const entry: SessionEntry = {
      watcher,
      cwd,
      pathRefs: new Map(),
      connectionPaths: new Map(),
      pendingChanges: [],
      pendingRawCount: 0,
      truncated: false,
      debounceTimer: undefined,
      seq: 0,
    };
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

  private disposeSessionEntry(sessionId: string, entry: SessionEntry): void {
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = undefined;
    }
    void entry.watcher.close().catch((err) => {
      this.logger.warn(
        { sessionId, err: String(err) },
        'fs-watcher close failed',
      );
    });
    this.sessions.delete(sessionId);
  }

  private onRawChange(
    sessionId: string,
    entry: SessionEntry,
    eventName: string,
    absPath: string,
  ): void {
    if (this._isDisposed) return;
    const action = mapChokidarEventToAction(eventName);
    if (action === undefined) return; // 'ready', 'raw', 'all', 'error'
    const kind = mapChokidarEventToKind(eventName);

    entry.pendingRawCount += 1;
    if (entry.truncated) {
      // Already over threshold — keep counting but don't accumulate per-entry.
    } else {
      entry.pendingChanges.push({ absPath, action, kind });
      if (entry.pendingChanges.length > this.maxChangesPerWindow) {
        entry.truncated = true;
        // Drop accumulated detail to free memory; we only emit the count.
        entry.pendingChanges = [];
      }
    }

    if (entry.debounceTimer === undefined) {
      const timer = setTimeout(() => this.flushWindow(sessionId), this.debounceMs);
      // Unref so tests don't keep the loop alive on lingering windows.
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
    // Reset for next window BEFORE emit (defensive: emit could schedule a
    // synchronous re-fire if the consumer turns around and writes a file).
    entry.pendingChanges = [];
    entry.pendingRawCount = 0;
    entry.truncated = false;

    // Build per-connection filtered payload.
    for (const [connectionId, connPaths] of entry.connectionPaths) {
      const sink = this.lookup.resolve(connectionId);
      if (!sink) continue;
      let perConnChanges: FsChangeEntry[];
      if (truncated) {
        perConnChanges = [];
      } else {
        perConnChanges = [];
        for (const ch of pending) {
          if (!isUnderAny(ch.absPath, connPaths)) continue;
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
      } catch (err) {
        this.logger.warn(
          { connectionId, err: String(err) },
          'fs-watcher send failed',
        );
      }
    }
  }

  override dispose(): void {
    if (this._isDisposed) return;
    const entries = Array.from(this.sessions.entries());
    for (const [sid, e] of entries) {
      this.disposeSessionEntry(sid, e);
    }
    this.connections.clear();
    super.dispose();
  }
}

/* -------------------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------------- */

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
    // `add` / `change` / `unlink` are file events in chokidar 4. Symlinks
    // emit as `add` with no separate event; consumers that need to
    // distinguish should call `:stat`. We classify as `file` here; the
    // wire schema also accepts `symlink` but we don't generate it.
    default:
      return 'file';
  }
}

function isUnderAny(absPath: string, parents: Set<string>): boolean {
  for (const parent of parents) {
    if (absPath === parent) return true;
    // Must check with separator to avoid '/foo/bar2' under '/foo/bar'
    // false-positive. We add `path.sep` once.
    const sep = nodePath.sep;
    if (absPath.startsWith(parent + sep)) return true;
    // POSIX cross-check (some test paths may pre-canonicalize separators).
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
  // Common prefix path-segment walk.
  let prefix = absPaths[0]!.split(nodePath.sep);
  for (let i = 1; i < absPaths.length; i++) {
    const segs = absPaths[i]!.split(nodePath.sep);
    let j = 0;
    while (j < prefix.length && j < segs.length && prefix[j] === segs[j]) j++;
    prefix = prefix.slice(0, j);
  }
  return prefix.length === 0 ? '/' : prefix.join(nodePath.sep) || nodePath.sep;
}
