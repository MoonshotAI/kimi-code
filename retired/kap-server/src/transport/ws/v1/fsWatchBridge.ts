/**
 * `FsWatchBridge` — volatile `/api/v1/ws` delivery for filesystem changes.
 *
 * Protocol (byte-compatible with v1):
 *
 *   client → `{type:'watch_fs_add',    id, payload:{session_id, paths}}`
 *   client → `{type:'watch_fs_remove', id, payload:{session_id, paths}}`
 *   server → `{type:'ack', id, code, payload:{watched_paths, current_count}}`
 *   server → `{type:'event.fs.changed', seq, session_id, timestamp, payload}`
 *
 * Engine mode (the only mode): session fs is owned by the Rust engine, so the
 * host fs-watch bridge is a **no-op** that still acks so WS clients don't
 * retry. The v2 `ISessionFsWatchService` feed was retired with the engine
 * migration; the frame/ack shapes are kept so the WS protocol contract is
 * unchanged.
 */

import type { EventEnvelope, JournalLogger } from './sessionEventJournal';

export const FS_WATCH_CODE = {
  OK: 0,
  PATH_ESCAPES: 41304,
  LIMIT_EXCEEDED: 42902,
  SESSION_NOT_FOUND: 40409,
} as const;

/** One changed path in an `event.fs.changed` payload (v1 wire shape). */
export interface FsChangeEntry {
  readonly path: string;
  readonly kind?: 'file' | 'directory' | 'unknown';
  readonly change?: 'created' | 'changed' | 'deleted';
}

/** The volatile fs-change event payload (v1 wire shape). */
export interface FsChangeEvent {
  readonly changes: FsChangeEntry[];
  readonly coalesced_window_ms?: number;
  readonly truncated?: boolean;
  readonly count?: number;
}

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

/**
 * Engine mode: fs ownership belongs to the Rust engine — the host bridge is a
 * protocol shell that acks every watch request as successful without actually
 * watching (the engine's own fs is surfaced through the session RPC surface).
 */
export class FsWatchBridge {
  private readonly logger: JournalLogger | undefined;

  constructor(opts: { logger?: JournalLogger; disabled?: boolean }) {
    this.logger = opts.logger;
  }

  async addWatch(
    _conn: FsWatchConnection,
    _sessionId: string,
    rawPaths: readonly string[],
  ): Promise<FsWatchAck> {
    return {
      code: FS_WATCH_CODE.OK,
      msg: 'success',
      watched_paths: [...rawPaths],
      current_count: rawPaths.length,
    };
  }

  async removeWatch(
    _conn: FsWatchConnection,
    _sessionId: string,
    _rawPaths: readonly string[],
  ): Promise<FsWatchAck> {
    return { code: FS_WATCH_CODE.OK, msg: 'success', watched_paths: [], current_count: 0 };
  }

  /** Drop every subscription held by `conn` (called on socket close). No-op in engine mode. */
  detachConnection(_conn: FsWatchConnection): void {
    // Nothing to detach — the bridge holds no per-connection state.
  }
}
