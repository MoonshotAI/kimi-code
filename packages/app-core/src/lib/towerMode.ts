export const TOWER_STATUS_PROMPT =
  'Report the current tower status: call TowerStatus and give a compact summary.';
export const TOWER_TEARDOWN_PROMPT =
  'Tear down the tower: call TowerTeardown and report what it did. It refuses to destroy dirty worktrees unless forced.';

let towerWriteSeq = 0;

export function markTowerPending(
  state: { pendingTowerBySession: Record<string, number> },
  sessionId: string,
): number {
  const token = ++towerWriteSeq;
  state.pendingTowerBySession[sessionId] = token;
  return token;
}

export function ackTowerPending(
  state: { pendingTowerBySession: Record<string, number> },
  sessionId: string,
  token: number | undefined,
): boolean {
  if (token === undefined || state.pendingTowerBySession[sessionId] !== token) return false;
  delete state.pendingTowerBySession[sessionId];
  return true;
}

export function foldDaemonTowerMode(
  state: {
    towerModeBySession: Record<string, boolean>;
    pendingTowerBySession: Record<string, number>;
  },
  sessionId: string,
  daemonMode: boolean,
): void {
  if (state.pendingTowerBySession[sessionId] !== undefined) return;
  state.towerModeBySession[sessionId] = daemonMode;
}
