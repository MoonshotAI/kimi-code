// packages/app-core/src/lib/swarmMode.ts
// Optimistic swarm-mode writes race daemon reports (the transcript meta fold
// and the /status REST fold) exactly the way thinking picks do — see
// modelThinking.ts. Same token-shield shape, separate key: a pending swarm
// write drops daemon folds until its own completion acks, so a stale report
// can't flip the toggle back mid-write (and a thinking write never acks a
// swarm write).

// Monotonic source for pending-write tokens: token (not value) equality
// decides which completion acks which write — the same value can be written
// twice with another value in between.
let swarmWriteSeq = 0;

/** Mark a locally written swarm-mode pick as not yet acknowledged by the
 *  daemon, returning its write token. While pending, every daemon fold is
 *  dropped (foldDaemonSwarmMode) — a report cannot tell which write it
 *  reflects, so only the write's own completion acks (ackSwarmPending). */
export function markSwarmPending(
  state: { pendingSwarmBySession: Record<string, number> },
  sessionId: string,
): number {
  const token = ++swarmWriteSeq;
  state.pendingSwarmBySession[sessionId] = token;
  return token;
}

/** Clear the pending mark for a completed write; a newer pick keeps its own
 *  shield. Returns whether the mark was cleared. */
export function ackSwarmPending(
  state: { pendingSwarmBySession: Record<string, number> },
  sessionId: string,
  token: number | undefined,
): boolean {
  if (token === undefined || state.pendingSwarmBySession[sessionId] !== token) return false;
  delete state.pendingSwarmBySession[sessionId];
  return true;
}

/** Fold a daemon-reported swarm mode into the session's own entry — dropped
 *  while a local pick is pending (markSwarmPending). */
export function foldDaemonSwarmMode(
  state: {
    swarmModeBySession: Record<string, boolean>;
    pendingSwarmBySession: Record<string, number>;
  },
  sessionId: string,
  daemonMode: boolean,
): void {
  if (state.pendingSwarmBySession[sessionId] !== undefined) return;
  state.swarmModeBySession[sessionId] = daemonMode;
}
