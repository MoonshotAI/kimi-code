
let planWriteSeq = 0;

export function markPlanPending(
  state: { pendingPlanBySession: Record<string, number> },
  sessionId: string,
): number {
  const token = ++planWriteSeq;
  state.pendingPlanBySession[sessionId] = token;
  return token;
}

export function ackPlanPending(
  state: { pendingPlanBySession: Record<string, number> },
  sessionId: string,
  token: number | undefined,
): boolean {
  if (token === undefined || state.pendingPlanBySession[sessionId] !== token) return false;
  delete state.pendingPlanBySession[sessionId];
  return true;
}

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
