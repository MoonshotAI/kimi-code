/**
 * Shared helpers for the tower builtin tools: store construction, caller
 * identity resolution, and uniform error mapping. The tower workspace always
 * anchors at the main checkout (the tower's working directory) — workers
 * whose cwd was overridden to their worktree still talk to the same
 * `.tower/` tree.
 */

import { basename } from 'node:path';

import type { Agent } from '#/agent';

import {
  TowerProtocolError,
  TowerStore,
  GitError,
  TOWER_NAME,
  WORKTREES_DIR,
} from '../../../agent/tower';
import type { TowerState } from '../../../agent/tower';
import type { ExecutableToolResult } from '../../../loop/types';

/** The store root is the main checkout holding `.tower/`. */
export function newStore(agent: Agent): TowerStore {
  return new TowerStore(resolveTowerRepoRoot(agent.config.cwd));
}

/**
 * Tower worktrees always live at `<repoRoot>/.tower/worktrees/<slot>`, so a
 * caller anchored inside one maps back to the main checkout by convention —
 * no state lookup needed (which would be circular: reading state requires the
 * store root).
 */
export function resolveTowerRepoRoot(cwd: string): string {
  const normalized = cwd.replaceAll('\\', '/');
  const marker = `/${WORKTREES_DIR}/`;
  const index = normalized.indexOf(marker);
  if (index === -1) return cwd;
  return cwd.slice(0, index);
}

/**
 * Resolve the caller's tower identity. The main agent is the control tower;
 * a spawned worker/reviewer is looked up in the roster by its agent id, which
 * is the basename of its homedir (`…/agents/agent-3` → `agent-3`).
 */
export function callerName(agent: Agent, state: TowerState): string {
  if (agent.type === 'main') return TOWER_NAME;
  if (agent.homedir === undefined) {
    throw new TowerProtocolError(
      'cannot resolve a tower identity: this agent has no homedir to derive an agent id from',
    );
  }
  return newStore(agent).resolveCallerName(state, basename(agent.homedir));
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
