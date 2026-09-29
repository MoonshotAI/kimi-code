import { z } from 'zod';

import { MAIN_AGENT_ID, type ToolDefinition } from '@moonshot-ai/agent-core';

import { TowerProtocolError } from '../protocol/index';

import DESCRIPTION from './init.md?raw';
import {
  errorText,
  newTowerStore,
  parseTowerArgs,
  runTowerTool,
  text,
  toInputJsonSchema,
  TOWER_MAIN_AGENT_ONLY,
  TOWER_MODE_USER_ENABLED_ONLY,
  type TowerToolDeps,
} from './support';

export const TowerInitToolInputSchema = z
  .object({
    base: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Local branch that missions fork from and merge back into (e.g. "develop"). Defaults to the branch currently checked out in the main worktree. Remote-tracking refs (e.g. "origin/main") and tags are not accepted — create a local branch first.',
      ),
  })
  .strict();

export type TowerInitToolInput = z.infer<typeof TowerInitToolInputSchema>;

export function createTowerInitTool(deps: TowerToolDeps): ToolDefinition {
  return {
    name: 'TowerInit',
    description: DESCRIPTION,
    parameters: toInputJsonSchema(TowerInitToolInputSchema),
    execute({ toolCall }) {
      if (deps.agentId !== MAIN_AGENT_ID) {
        return Promise.resolve(errorText(TOWER_MAIN_AGENT_ONLY));
      }
      if (!deps.isActive()) {
        return Promise.resolve(errorText(TOWER_MODE_USER_ENABLED_ONLY));
      }
      const parsed = parseTowerArgs(TowerInitToolInputSchema, toolCall.arguments, 'TowerInit');
      if ('parseError' in parsed) return Promise.resolve(errorText(parsed.parseError));
      const args = parsed.args;
      return runTowerTool(async () => {
        const store = newTowerStore(deps);
        const priorOwner = await store.load().then(
          (state) => state.sessionId,
          () => undefined,
        );
        if (
          priorOwner !== undefined &&
          priorOwner !== deps.sessionId &&
          deps.isSessionLive(priorOwner)
        ) {
          throw new TowerProtocolError(
            `tower workspace is owned by a live session (${priorOwner}) — adopting it would retire that session's roster. Use the tower from that session, or close it first.`,
          );
        }
        const result = await store.init(deps.sessionId, args.base ?? deps.requestedBase());
        return text(
          [
            result.created
              ? 'tower workspace initialized'
              : 'tower workspace already initialized — existing state preserved',
            `base branch: ${result.base}`,
            ...(result.ignoredBase !== undefined
              ? [
                  `requested base "${result.ignoredBase}" ignored — the existing workspace already records base "${result.base}"; tear it down first to rebase the tower`,
                ]
              : []),
            ...(result.checkout !== result.base
              ? [
                  result.checkout === 'HEAD'
                    ? `note: the main checkout is in a detached HEAD state — merges stay blocked until the base is checked out (git checkout ${result.base})`
                    : `note: the main checkout is on "${result.checkout}", not base "${result.base}" — merges stay blocked until it is switched over (git checkout ${result.base})`,
                ]
              : []),
            'workspace: .tower/ (comms under .tower/comms/, worktrees under .tower/worktrees/)',
            ...(result.openMissions.length > 0
              ? [
                  `carried-over open missions: ${result.openMissions.join(', ')} — their scopes are still reserved. Continue them (TowerSpawn fresh workers), or — when they belong to an unrelated earlier task — abandon them first (TowerMission status=abandoned) so a new plan can use those files.`,
                ]
              : []),
            ...(result.retiredAgents.length > 0
              ? [
                  `adopted from a previous session — retired its stale roster entries: ${result.retiredAgents.join(', ')}. ` +
                    'Their agents belong to the dead session and cannot be resumed; missions and worktrees are preserved — TowerSpawn fresh workers to continue them.',
                ]
              : []),
            '',
            'Tower mode is active and the tower tool set is enabled.',
            'Next: split the work with TowerPlan (one mission per disjoint file scope), then TowerSpawn a worker per mission. Assign reviewers for their branches, and merge with TowerMerge only after a clean review.',
          ].join('\n'),
        );
      });
    },
  };
}
