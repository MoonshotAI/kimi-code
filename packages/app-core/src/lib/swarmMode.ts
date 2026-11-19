
let swarmWriteSeq = 0;

export function markSwarmPending(
  state: { pendingSwarmBySession: Record<string, number> },
  sessionId: string,
): number {
  const token = ++swarmWriteSeq;
  state.pendingSwarmBySession[sessionId] = token;
  return token;
}

export function ackSwarmPending(
  state: { pendingSwarmBySession: Record<string, number> },
  sessionId: string,
  token: number | undefined,
): boolean {
  if (token === undefined || state.pendingSwarmBySession[sessionId] !== token) return false;
  delete state.pendingSwarmBySession[sessionId];
  return true;
}

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
