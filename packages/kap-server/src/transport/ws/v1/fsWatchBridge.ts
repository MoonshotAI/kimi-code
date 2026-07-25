/**
 * `FsWatchBridge` — volatile `/api/v1/ws` delivery for filesystem changes.
 *
 * Turns the core `ISessionFsWatchService.onDidChangeFiles` feed into
 * `event.fs.changed` frames on the v1 WebSocket, byte-compatible with the v1
 * server (`packages/server/.../fsWatcherService.ts`):
 *
 *   client → `{type:'watch_fs_add',    id, payload:{session_id, paths}}`
 *   client → `{type:'watch_fs_remove', id, payload:{session_id, paths}}`
 *   server → `{type:'ack', id, code, payload:{watched_paths, current_count}}`
 *   server → `{type:'event.fs.changed', seq, session_id, timestamp, payload}`
 *
 * The bridge is transport state (like {@link ConnectionRegistry} /
 * {@link SessionEventBroadcaster}); it is **not** DI-registered and carries no
 * `_serviceBrand`. It owns the per-`(connection, session)` subscription sets,
 * fans the core feed out to each connection filtered by that connection's
 * paths, and assigns a per-session monotonic `seq`. Frames are sent straight
 * to the socket — they never enter the broadcaster / journal (fs changes are
 * volatile: on overflow the client sees `truncated` and re-syncs).
 *
 * The core `ISessionFsWatchService` keeps a single subscription set per
 * session; the bridge drives it with the **union** of every connection's
 * paths for that session, then re-filters per connection on the way out.
 */

import { isAbsolute, relative, sep } from 'node:path';

import {
  type IDisposable,
  type ISessionScopeHandle,
  ISessionFsWatchService,
  ISessionLifecycleService,
  ISessionWorkspaceContext,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { FsChangeEntry, FsChangeEvent } from '@moonshot-ai/agent-core-v2/session/sessionFs/fsWatch';

import type { EventEnvelope, JournalLogger } from './sessionEventJournal';

const MAX_PATHS_PER_CONNECTION = 100;

export const FS_WATCH_CODE = {
  OK: 0,
  PATH_ESCAPES: 41304,
  LIMIT_EXCEEDED: 42902,
  SESSION_NOT_FOUND: 40409,
} as const;

export interface FsChangedFrame {
  readonly type: 'event.fs.changed';
  readonly seq: number;
  readonly session_id: string;
  readonly timestamp: string;
  readonly payload: FsChangeEvent;
}

/** Minimal connection surface the bridge needs (satisfied by `WsConnectionV1`). */
export interface FsWatchConnection {
  readonly id: string;
  send(envelope: EventEnvelope): void;
}

export interface FsWatchAck {
  readonly code: number;
  readonly msg: string;
  readonly watched_paths?: readonly string[];
  readonly current_count?: number;
}

interface ConnEntry {
  readonly conn: FsWatchConnection;
  readonly paths: Set<string>;
}

interface SessionWatch {
  readonly id: string;
  readonly session: ISessionScopeHandle;
  readonly fsWatch: ISessionFsWatchService;
  readonly workspace: ISessionWorkspaceContext;
  readonly conns: Map<string, ConnEntry>;
  union: Set<string>;
  seq: number;
  sub: IDisposable | undefined;
}

export class FsWatchBridge {
  private readonly core: Scope;
  private readonly logger: JournalLogger | undefined;
  private readonly bySession = new Map<string, SessionWatch>();
  private readonly connPathCount = new Map<string, number>();

  constructor(opts: { core: Scope; logger?: JournalLogger }) {
    this.core = opts.core;
    this.logger = opts.logger;
  }

  async addWatch(
    conn: FsWatchConnection,
    sessionId: string,
    rawPaths: readonly string[],
  ): Promise<FsWatchAck> {
    const resolved = this.resolveSession(sessionId);
    if (resolved === undefined) {
      return { code: FS_WATCH_CODE.SESSION_NOT_FOUND, msg: 'session not found' };
    }
    const sw = resolved;

    const normalized: string[] = [];
    for (const raw of rawPaths) {
      const rel = this.normalize(sw, raw);
      if (rel === undefined) {
        return { code: FS_WATCH_CODE.PATH_ESCAPES, msg: 'fs.path_escapes_session' };
      }
      normalized.push(rel);
    }

    let entry = sw.conns.get(conn.id);
    const toAdd: string[] = [];
    for (const rel of normalized) {
      if (entry?.paths.has(rel)) continue;
      toAdd.push(rel);
    }
    const current = this.connPathCount.get(conn.id) ?? 0;
    if (current + toAdd.length > MAX_PATHS_PER_CONNECTION) {
      return { code: FS_WATCH_CODE.LIMIT_EXCEEDED, msg: 'fs.watch_limit_exceeded' };
    }

    if (entry === undefined) {
      entry = { conn, paths: new Set() };
      sw.conns.set(conn.id, entry);
    }
    for (const rel of toAdd) entry.paths.add(rel);
    this.connPathCount.set(conn.id, current + toAdd.length);
    this.recomputeAndApply(sw);

    return this.ok(sw, conn);
  }

  async removeWatch(
    conn: FsWatchConnection,
    sessionId: string,
    rawPaths: readonly string[],
  ): Promise<FsWatchAck> {
    const sw = this.bySession.get(sessionId);
    const entry = sw?.conns.get(conn.id);
    if (sw === undefined || entry === undefined) {
      return { code: FS_WATCH_CODE.OK, msg: 'success', watched_paths: [], current_count: this.countFor(conn.id) };
    }

    let removed = 0;
    for (const raw of rawPaths) {
      const rel = this.normalize(sw, raw) ?? raw;
      if (entry.paths.delete(rel)) removed += 1;
    }
    this.connPathCount.set(conn.id, Math.max(0, this.countFor(conn.id) - removed));
    if (entry.paths.size === 0) sw.conns.delete(conn.id);
    this.recomputeAndApply(sw);
    if (sw.conns.size === 0) this.teardownSession(sw);

    return this.ok(sw, conn);
  }

  /** Drop every subscription held by `conn` (called on socket close). */
  detachConnection(conn: FsWatchConnection): void {
    for (const sw of Array.from(this.bySession.values())) {
      const entry = sw.conns.get(conn.id);
      if (entry === undefined) continue;
      sw.conns.delete(conn.id);
      this.connPathCount.set(conn.id, Math.max(0, this.countFor(conn.id) - entry.paths.size));
      this.recomputeAndApply(sw);
      if (sw.conns.size === 0) this.teardownSession(sw);
    }
    this.connPathCount.delete(conn.id);
  }

  private resolveSession(sessionId: string): SessionWatch | undefined {
    const existing = this.bySession.get(sessionId);
    if (existing !== undefined) return existing;
    const session = this.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) return undefined;
    const sw: SessionWatch = {
      id: sessionId,
      session,
      fsWatch: session.accessor.get(ISessionFsWatchService),
      workspace: session.accessor.get(ISessionWorkspaceContext),
      conns: new Map(),
      union: new Set(),
      seq: 0,
      sub: undefined,
    };
    this.bySession.set(sessionId, sw);
    return sw;
  }

  private recomputeAndApply(sw: SessionWatch): void {
    const union = new Set<string>();
    for (const { paths } of sw.conns.values()) {
      for (const p of paths) union.add(p);
    }
    sw.union = union;
    sw.fsWatch.setWatchedPaths([...union]);
    if (union.size > 0 && sw.sub === undefined) {
      sw.sub = sw.fsWatch.onDidChangeFiles((ev) => this.onSessionEvent(sw.id, ev));
    }
  }

  private teardownSession(sw: SessionWatch): void {
    sw.sub?.dispose();
    sw.sub = undefined;
    sw.fsWatch.setWatchedPaths([]);
    this.bySession.delete(sw.id);
  }

  private onSessionEvent(sessionId: string, ev: FsChangeEvent): void {
    const sw = this.bySession.get(sessionId);
    if (sw === undefined) return;
    for (const { conn, paths } of sw.conns.values()) {
      let changes: FsChangeEntry[];
      if (ev.truncated === true) {
        changes = [];
      } else {
        changes = ev.changes.filter((c) => isUnderAny(c.path, paths));
        if (changes.length === 0) continue;
      }
      sw.seq += 1;
      const frame: FsChangedFrame = {
        type: 'event.fs.changed',
        seq: sw.seq,
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        payload: {
          changes,
          coalesced_window_ms: ev.coalesced_window_ms,
          ...(ev.truncated === true ? { truncated: true, count: ev.count } : {}),
        },
      };
      try {
        conn.send(frame as EventEnvelope);
      } catch (error) {
        this.logger?.warn({ sessionId, err: String(error) }, 'fs-watch send failed');
      }
    }
  }

  /** Lexical confinement + workspace-relative normalization (no `stat`). */
  private normalize(sw: SessionWatch, raw: string): string | undefined {
    if (raw === '' || raw === '/') return undefined;
    if (isAbsolute(raw)) return undefined;
    if (raw.split(/[/\\]+/).some((s) => s === '..')) return undefined;
    const abs = sw.workspace.resolve(raw);
    if (!sw.workspace.isWithin(abs)) return undefined;
    return toRel(sw.workspace.workDir, abs);
  }

  private ok(sw: SessionWatch, conn: FsWatchConnection): FsWatchAck {
    const entry = sw.conns.get(conn.id);
    return {
      code: FS_WATCH_CODE.OK,
      msg: 'success',
      watched_paths: entry === undefined ? [] : [...entry.paths].sort(),
      current_count: this.countFor(conn.id),
    };
  }

  private countFor(connId: string): number {
    return this.connPathCount.get(connId) ?? 0;
  }
}

function toRel(cwd: string, abs: string): string {
  if (abs === cwd) return '.';
  const rel = relative(cwd, abs);
  if (rel === '') return '.';
  return rel.split(sep).join('/');
}

function isUnderAny(rel: string, parents: ReadonlySet<string>): boolean {
  for (const parent of parents) {
    if (parent === '.' || parent === '') return true;
    if (rel === parent) return true;
    if (rel.startsWith(`${parent}/`)) return true;
  }
  return false;
}
