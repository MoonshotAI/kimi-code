// packages/app-client/src/composables/useMainTranscriptHost.ts
// The main-flow migration's transcript host: owns the per-session main
// channel pool and routes transcript frames into it. Phase 1/2 ran it over a
// companion connection (the session_event pipeline needed the main connection
// grade-free for the diff); Phase 3 merges onto the shared main connection —
// the server then suppresses the projected session_event for the main agent
// on it, which is exactly what retires the legacy message pipeline.

import type { KimiEventConnection, KimiWebApi } from '@moonshot-ai/app-core/api';

import { createMainTranscriptPool, type MainTranscriptEntry } from './useMainTranscripts';

const MAIN_AGENT_ID = 'main';

export function createMainTranscriptHost(deps: {
  api: KimiWebApi;
  maxResidentSessions?: number;
  /** Phase 3 connection merge: share the caller's main event connection
   *  instead of opening a companion one. The caller routes the main agent's
   *  transcript frames into the pool and owns the connection's lifecycle and
   *  stale recovery. */
  getSharedConnection?: () => KimiEventConnection | null;
  ensureSharedConnection?: () => void;
  /** A session's transcript read returned not-found — the session is gone
   *  server-side and needs the facade's full teardown (forgetSession). */
  onSessionGone?: (sessionId: string) => void;
  /** The facade's local-turn-start snapshot (generation/pending) — a baseline
   *  read that spans a local submit must re-anchor, not reap the prompt. */
  getLocalTurnState?: (sessionId: string) => { generation: number; pending: boolean };
  /** True while the session has a local prompt lifecycle outstanding — its
   *  entry is pinned past the resident cap so the queue can't be stranded. */
  hasPendingLocalWork?: (sessionId: string) => boolean;
  /** The session's first transcript read failed — surfaced to the user as an
   *  ordinary operation failure by the facade. */
  onBaselineError?: (sessionId: string, err: unknown) => void;
}) {
  let connection: KimiEventConnection | null = null;
  const shared = deps.getSharedConnection !== undefined;

  const pool = createMainTranscriptPool({
    api: deps.api,
    connectEventsIfNeeded: () => {
      if (shared) deps.ensureSharedConnection?.();
      else ensureConnection();
    },
    getEventConnection: () => (shared ? deps.getSharedConnection!() : connection),
    maxResidentSessions: deps.maxResidentSessions,
    onSessionGone: deps.onSessionGone,
    getLocalTurnState: deps.getLocalTurnState,
    hasPendingLocalWork: deps.hasPendingLocalWork,
    onBaselineError: deps.onBaselineError,
  });

  function ensureConnection(): void {
    if (connection !== null) return;
    connection = deps.api.connectTranscriptChannel({
      onTranscriptReset: (sessionId, agentId, snapshot, seq) => {
        if (agentId === MAIN_AGENT_ID) pool.receiveReset(sessionId, snapshot, seq);
      },
      onTranscriptOps: (sessionId, agentId, ops, seq) =>
        agentId === MAIN_AGENT_ID ? pool.applyOps(sessionId, ops, seq) : true,
    });
  }

  // Same silent-half-open recovery as the legacy connection: after a frozen
  // background tab no onclose fires, so the socket must be force-reconnected
  // on focus — the handshake replays this connection's transcript
  // subscriptions at their last durable watermarks. Shared mode: the main
  // connection recovers itself.
  function recoverIfStale(): void {
    if (shared || connection === null) return;
    if (!connection.health().stale) return;
    connection.reconnect();
  }

  return {
    pool,
    activate: (sessionId: string): MainTranscriptEntry => pool.activate(sessionId),
    deactivate: (sessionId: string): void => pool.deactivate(sessionId),
    forgetSession: (sessionId: string): void => pool.forgetSession(sessionId),
    /** Re-run the resident-cap trim (a pinned session's local work settled). */
    trimResident: (): void => pool.trimResident(),
    recoverIfStale,
    close: (): void => {
      if (!shared) connection?.close();
    },
  };
}

export type MainTranscriptHost = ReturnType<typeof createMainTranscriptHost>;
