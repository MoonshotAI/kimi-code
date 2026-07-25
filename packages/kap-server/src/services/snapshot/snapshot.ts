/**
 * `ISnapshotReader` — server-layer disk reader backing
 * `GET /sessions/{sid}/snapshot` in `auto` mode.
 *
 * Reads `state.json` + `agents/main/wire.jsonl` directly from disk, bypassing
 * the `ISessionLifecycleService.resume` chain (DI-scope materialization, MCP
 * connect, full wire replay). Mirrors v1's `ISnapshotService`
 * (`packages/server/src/services/snapshot/snapshot.ts`).
 */

import type { SessionSnapshotResponse } from '../../protocol/rest-snapshot';

export interface ISnapshotReader {
  /** Assemble the atomic snapshot for `sid`. Throws `SnapshotNotFoundError` when the session (or its workspace) is absent on disk. */
  read(sid: string): Promise<SessionSnapshotResponse>;
}

/** Sentinel — route maps to 40401. */
export class SnapshotNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'SnapshotNotFoundError';
    this.sessionId = sessionId;
  }
}

/** Sentinel — route maps to 50001 with a structured `snapshot.timeout` log. */
export class SnapshotTimeoutError extends Error {
  readonly sessionId: string;
  readonly timeoutMs: number;
  constructor(sessionId: string, timeoutMs: number) {
    super(`snapshot ${sessionId} timed out after ${timeoutMs}ms`);
    this.name = 'SnapshotTimeoutError';
    this.sessionId = sessionId;
    this.timeoutMs = timeoutMs;
  }
}
