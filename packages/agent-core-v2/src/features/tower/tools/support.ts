import {
  GitError,
  TowerProtocolError,
  TowerStore,
  resolveTowerRepoRoot,
  type TowerState,
} from '#/features/tower/protocol/index';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ExecutableToolResult } from '#/tool/toolContract';

/** The store root is the main checkout holding `.tower/`. */
export function newTowerStore(sessionContext: ISessionContext): TowerStore {
  return new TowerStore(resolveTowerRepoRoot(sessionContext.cwd));
}

export const TOWER_MAIN_AGENT_ONLY =
  'Tower orchestration tools are only supported by the main agent.';

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
