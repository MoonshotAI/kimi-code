import {
  GitError,
  TowerProtocolError,
  TowerStore,
  resolveTowerRepoRoot,
  type TowerState,
} from '#/features/tower/protocol/index';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ExecutableToolResult } from '#/tool/toolContract';

export function newTowerStore(sessionContext: ISessionContext): TowerStore {
  return new TowerStore(resolveTowerRepoRoot(sessionContext.cwd));
}

export const TOWER_MAIN_AGENT_ONLY =
  'Tower orchestration tools are only supported by the main agent.';

export const TOWER_MODE_USER_ENABLED_ONLY =
  'tower mode is not active — only the user can enable it (with /tower on), never the agent. ' +
  'Ask the user to turn tower mode on, then drive the tower protocol.';

export function callerName(agentId: string, store: TowerStore, state: TowerState): string {
  return store.resolveCallerName(state, agentId);
}

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
