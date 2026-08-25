// packages/app-core/src/lib/planMode.ts
// Optimistic plan-mode writes race daemon reports (the transcript meta fold
// and the /status REST fold) exactly the way thinking picks and swarm-mode
// writes do — see modelThinking.ts / swarmMode.ts. Same token-shield shape,
// separate key: a pending plan write drops daemon folds until its own
// completion acks, so a stale report can't flip the mode back mid-write (and
// the next prompt won't resubmit with the old mode).

// Monotonic source for pending-write tokens: token (not value) equality
// decides which completion acks which write — the same value can be written
// twice with another value in between.
let planWriteSeq = 0;

/** Mark a locally written plan-mode pick as not yet acknowledged by the
 *  daemon, returning its write token. While pending, every daemon fold is
 *  dropped (foldDaemonPlanMode) — a report cannot tell which write it
 *  reflects, so only the write's own completion acks (ackPlanPending). */
export function markPlanPending(
  state: { pendingPlanBySession: Record<string, number> },
  sessionId: string,
): number {
  const token = ++planWriteSeq;
  state.pendingPlanBySession[sessionId] = token;
  return token;
}

/** Clear the pending mark for a completed write; a newer pick keeps its own
 *  shield. Returns whether the mark was cleared. */
export function ackPlanPending(
  state: { pendingPlanBySession: Record<string, number> },
  sessionId: string,
  token: number | undefined,
): boolean {
  if (token === undefined || state.pendingPlanBySession[sessionId] !== token) return false;
  delete state.pendingPlanBySession[sessionId];
  return true;
}

/** Fold a daemon-reported plan mode into the session's own entry — dropped
 *  while a local pick is pending (markPlanPending). */
export function foldDaemonPlanMode(
  state: {
    planModeBySession: Record<string, boolean>;
    pendingPlanBySession: Record<string, number>;
  },
  sessionId: string,
  daemonMode: boolean,
): void {
  if (state.pendingPlanBySession[sessionId] !== undefined) return;
  state.planModeBySession[sessionId] = daemonMode;
}
