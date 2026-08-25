import { isAbsolute, relative, sep } from 'node:path';

import {
  type IDisposable,
  ISessionWorkspaceContext,
  ISessionContext,
  IWorkspaceInstanceManager,
  getLiveSessionById,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { Program } from '@moonshot-ai/agent-core-v2/program/program';
import type {
  FsChangeEntry,
  FsChangeEvent,
  IWorkspaceFsWatchSubscription,
} from '@moonshot-ai/agent-core-v2/workspace/workspaceFs/fsWatch';

import type { EventEnvelope, JournalLogger } from './sessionEventJournal';

const MAX_PATHS_PER_CONNECTION = 100;

function sessionRuntimeKey(sessionId: string, runtimeId: string): string {
  return `${sessionId}\0${runtimeId}`;
}

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
  readonly runtimeId: string;
  readonly workspaceId: string;
  readonly workspace: ISessionWorkspaceContext;
  readonly program: Program;
  readonly programSub: IDisposable;
  programGeneration: string | undefined;
  watchSub: IWorkspaceFsWatchSubscription | undefined;
  watchEventSub: IDisposable | undefined;
  readonly conns: Map<string, ConnEntry>;
  union: Set<string>;
  seq: number;
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
    runtimeId: string,
  ): Promise<FsWatchAck> {
    const sw = this.resolveSession(sessionId, runtimeId);
    if (sw === undefined) {
      return { code: FS_WATCH_CODE.SESSION_NOT_FOUND, msg: 'session not found' };
    }
    const watchSub = sw.watchSub;
    if (watchSub === undefined) {
      if (sw.conns.size === 0) this.teardownSession(sw);
      return { code: 1, msg: 'fs watch unavailable' };
    }

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
    try {
      await watchSub.ready;
    } catch (error) {
      for (const rel of toAdd) entry.paths.delete(rel);
      if (entry.paths.size === 0) sw.conns.delete(conn.id);
      this.connPathCount.set(conn.id, current);
      this.recomputeAndApply(sw);
      if (sw.conns.size === 0) this.teardownSession(sw);
      throw error;
    }

    return this.ok(sw, conn);
  }

  async removeWatch(
    conn: FsWatchConnection,
    sessionId: string,
    rawPaths: readonly string[],
    runtimeId: string,
  ): Promise<FsWatchAck> {
    const sw = this.bySession.get(sessionRuntimeKey(sessionId, runtimeId));
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

  dispose(): void {
    for (const sw of this.bySession.values()) this.teardownSession(sw);
  }

  private resolveSession(sessionId: string, runtimeId: string): SessionWatch | undefined {
    const key = sessionRuntimeKey(sessionId, runtimeId);
    const existing = this.bySession.get(key);
    if (existing !== undefined) return existing;

    const session = getLiveSessionById(this.core.accessor, sessionId);
    if (session === undefined) return undefined;
    if (runtimeId !== 'local') throw new Error(`fs watch unavailable for runtime "${runtimeId}"`);
    const workspace = session.accessor.get(ISessionWorkspaceContext);
    const workspaceId = session.accessor.get(ISessionContext).workspaceId;
    const instance = this.core.accessor.get(IWorkspaceInstanceManager).get(workspaceId);
    if (instance === undefined) throw new Error(`workspace "${workspaceId}" unavailable`);
    const program = instance.program;

    const sw: SessionWatch = {
      id: sessionId,
      runtimeId,
      workspaceId,
      workspace,
      program,
      programSub: program.onDidChange(() => {
        this.onProgramChange(sw);
      }),
      programGeneration: undefined,
      watchSub: undefined,
      watchEventSub: undefined,
      conns: new Map(),
      union: new Set(),
      seq: 0,
    };
    this.bySession.set(key, sw);
    this.attachWatch(sw);
    return sw;
  }

  private attachWatch(sw: SessionWatch): void {
    sw.watchEventSub?.dispose();
    sw.watchEventSub = undefined;
    sw.watchSub?.dispose();
    sw.watchSub = undefined;
    let service;
    try {
      service = sw.program.watch;
    } catch {
      sw.programGeneration = undefined;
      return;
    }
    sw.programGeneration = sw.program.snapshot().generation;
    const sub = service.subscribe();
    sw.watchSub = sub;
    sw.watchEventSub = sub.onDidChangeFiles((event) => {
      this.onWatchEvent(sw, event);
    });
    this.applyUnion(sw);
  }

  private onProgramChange(sw: SessionWatch): void {
    if (!this.bySession.has(sessionRuntimeKey(sw.id, sw.runtimeId))) return;
    if (sw.program.snapshot().generation === sw.programGeneration) return;
    this.attachWatch(sw);
  }

  private recomputeAndApply(sw: SessionWatch): void {
    const union = new Set<string>();
    for (const { paths } of sw.conns.values()) {
      for (const p of paths) union.add(p);
    }
    sw.union = union;
    this.applyUnion(sw);
  }

  private applyUnion(sw: SessionWatch): void {
    if (sw.watchSub === undefined) return;
    try {
      sw.watchSub.setWatchedPaths([...sw.union]);
    } catch (error) {
      this.logger?.warn({ sessionId: sw.id, err: String(error) }, 'fs-watch apply watched paths failed');
    }
  }

  private teardownSession(sw: SessionWatch): void {
    sw.programSub.dispose();
    sw.watchEventSub?.dispose();
    sw.watchSub?.dispose();
    this.bySession.delete(sessionRuntimeKey(sw.id, sw.runtimeId));
  }

  private onWatchEvent(sw: SessionWatch, ev: FsChangeEvent): void {
    if (!this.bySession.has(sessionRuntimeKey(sw.id, sw.runtimeId))) return;
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
        session_id: sw.id,
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
        this.logger?.warn({ sessionId: sw.id, err: String(error) }, 'fs-watch send failed');
      }
    }
  }

  private normalize(sw: SessionWatch, raw: string): string | undefined {
    if (raw === '' || raw === '/') return undefined;
    if (isAbsolute(raw)) return undefined;
    if (raw.split(/[/\\]+/).some((s) => s === '..')) return undefined;
    let absolute: string;
    try {
      absolute = sw.workspace.resolve(raw);
    } catch {
      return undefined;
    }
    if (!sw.workspace.isWithin(absolute)) return undefined;
    const rel = relative(sw.workspace.workDir, absolute);
    return rel === '' ? '.' : rel.split(sep).join('/');
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

function isUnderAny(rel: string, parents: ReadonlySet<string>): boolean {
  for (const parent of parents) {
    if (parent === '.' || parent === '') return true;
    if (rel === parent) return true;
    if (rel.startsWith(`${parent}/`)) return true;
  }
  return false;
}
