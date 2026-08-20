import {
  GitError,
  TowerProtocolError,
  TowerStore,
  resolveTowerRepoRoot,
  type TowerState,
} from '#/features/tower/protocol/index';
import type { ISessionManager } from '#/app/sessionManager/sessionManager';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ExecutableToolResult } from '#/tool/toolContract';

/** The store root is the main checkout holding `.tower/`. */
export function newTowerStore(sessionContext: ISessionContext): TowerStore {
  return new TowerStore(resolveTowerRepoRoot(sessionContext.cwd));
}

/**
 * Whether the session owning the workspace tower is still alive: a live
 * handle in this process settles it; otherwise fall back to the pid lease for
 * cross-process owners. A lease from this very process proves nothing about
 * session liveness (the process outlives its sessions), so it counts as stale.
 */
export async function towerOwnerAlive(
  store: TowerStore,
  sessions: ISessionManager,
  owner: string,
): Promise<boolean> {
  if (sessions.get(owner) !== undefined) return true;
  const lease = await store.readLease();
  if (lease === undefined || lease.sessionId !== owner) return false;
  if (lease.pid === process.pid) return false;
  try {
    process.kill(lease.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the caller's tower identity. The main agent is the control tower;
 * a spawned worker/reviewer is looked up in the roster by its agent id.
 */
export function callerName(agentId: string, store: TowerStore, state: TowerState): string {
  return store.resolveCallerName(state, agentId);
}

/**
 * Run a tower tool body, mapping expected protocol/git failures to error
 * results — their messages are written as next-step guidance for the model.
 * Unexpected (programming) errors keep propagating.
 */
export async function runTowerTool(
  execute: () => Promise<ExecutableToolResult>,
): Promise<ExecutableToolResult> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof TowerProtocolError || error instanceof GitError) {
      return { output: error.message, isError: true };
    }
    throw error;
  }
}
