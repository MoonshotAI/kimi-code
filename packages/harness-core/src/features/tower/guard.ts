import { isAbsolute, join, resolve } from 'pathe';

import type { LoopHooks, ToolStartingDecision } from '@moonshot-ai/agent-core/loop/index';

import { isWithinDirectory } from '#/features/os/path-access';

import { WORKTREES_DIR, type TowerStore } from './protocol/index';

export const TOWER_TODOLIST_DENIED =
  'TodoList is not available while tower mode is active — mission state lives in the tower protocol (TowerPlan/TowerMission/TowerStatus, MISSIONS.md), and todo semantics would serialize the fleet. Spawn every dependency-unblocked mission now, then end your turn: worker completions wake you.';

export function towerResumeDeniedMessage(name: string): string {
  return `Resuming tower agent "${name}" in the foreground would freeze the tower until it finishes — pass run_in_background=true instead; its completion (and any inbox traffic) will wake you.`;
}

export function towerWorktreeDeniedMessage(worktree: string, path: string): string {
  return (
    `tower workers may only write inside their own worktree (${worktree}) — denied: ${path}. ` +
    'Out-of-scope changes are not yours to make: file them with TowerFinding or ask the tower via TowerSend.'
  );
}

export function createTowerGuard(deps: {
  readonly ready: Promise<void>;
  readonly agentId: string;
  readonly workDir: string;
  readonly isActive: () => boolean;
  readonly isTowerWorker: () => boolean;
  readonly backgroundAvailable: () => boolean;
  readonly newStore: () => TowerStore;
}): LoopHooks['tool.starting'] {
  const { ready, agentId, workDir, isActive, isTowerWorker, backgroundAvailable, newStore } = deps;
  return async ({ toolCall }) => {
    await ready;
    if (isActive()) {
      if (toolCall.name === 'TodoList') {
        return deniedWith(TOWER_TODOLIST_DENIED);
      }
      if (toolCall.name === 'Agent') {
        const args = parseArgs(toolCall.arguments);
        const rawResume = args?.['resume'];
        const resume = typeof rawResume === 'string' ? rawResume.trim() : '';
        if (resume.length > 0 && args?.['run_in_background'] !== true && backgroundAvailable()) {
          const store = newStore();
          const entry = await store
            .load()
            .then(
              (state) => store.resolveAgent(state, resume),
              () => undefined,
            );
          if (entry !== undefined) {
            return deniedWith(towerResumeDeniedMessage(entry.name));
          }
        }
      }
    }
    if (isTowerWorker() && (toolCall.name === 'Write' || toolCall.name === 'Edit')) {
      const store = newStore();
      const entry = await store
        .load()
        .then(
          (state) => store.resolveAgent(state, agentId),
          () => undefined,
        );
      const slot = entry?.worktree;
      if (slot === undefined) return undefined;
      const target = readWriteTargetPath(toolCall.arguments);
      if (target === undefined) return undefined;
      const worktree = store.abs(join(WORKTREES_DIR, slot));
      const resolved = isAbsolute(target) ? target : resolve(workDir, target);
      if (isWithinDirectory(resolved, worktree)) return undefined;
      return deniedWith(towerWorktreeDeniedMessage(worktree, resolved));
    }
    return undefined;
  };
}

function deniedWith(text: string): ToolStartingDecision {
  return {
    blocked: { reason: 'tower_mode', message: text },
    result: { content: [{ type: 'text' as const, text }] },
  };
}

function parseArgs(raw: string | null): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '{}');
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  return parsed as Record<string, unknown>;
}

function readWriteTargetPath(raw: string | null): string | undefined {
  const record = parseArgs(raw);
  if (record === undefined) return undefined;
  const filePath = record['file_path'];
  if (typeof filePath === 'string') return filePath;
  const path = record['path'];
  return typeof path === 'string' ? path : undefined;
}
