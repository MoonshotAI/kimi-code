/**
 * `ISnapshotService` — server-layer reader that backs `GET /sessions/{sid}/snapshot`.
 *
 * Bypasses `ICoreProcessService.rpc.listSessions`/`resumeSession`/`getContext`
 * by reading `state.json` + `agents/main/wire.jsonl` directly from disk. See
 * `snapshotService.ts` for the rationale and cache invariants.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type { SessionSnapshotResponse } from '@moonshot-ai/protocol';

export interface ISnapshotService {
  readonly _serviceBrand: undefined;

  /** Assemble the atomic snapshot for `sid`. Throws `SnapshotNotFoundError` when the session does not exist on disk. */
  read(sid: string): Promise<SessionSnapshotResponse>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ISnapshotService = createDecorator<ISnapshotService>('snapshotService');

/** Sentinel — route maps to 40401. */
export class SnapshotNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'SnapshotNotFoundError';
    this.sessionId = sessionId;
  }
}

/** Sentinel — route maps to 50001 with code `SNAPSHOT_TIMEOUT`. */
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
