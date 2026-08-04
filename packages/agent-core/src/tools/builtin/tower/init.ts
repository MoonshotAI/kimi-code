/**
 * TowerInitTool — create the `.tower/` workspace, enter tower mode, and
 * activate the rest of the tower tool set. Idempotent: re-running against an
 * existing workspace reports `created: false`, keeps all state, and simply
 * re-enters mode and re-enables the tools (e.g. after a session resume).
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { newStore, runTowerTool } from './support';

export const TowerInitToolInputSchema = z.object({}).strict();

export type TowerInitToolInput = z.infer<typeof TowerInitToolInputSchema>;

/** Tools TowerInit adds to the active set: the tower tools plus the shared comms tools. */
const TOWER_TOOL_NAMES = [
  'TowerPlan',
  'TowerSpawn',
  'TowerMerge',
  'TowerTeardown',
  'TowerSend',
  'TowerInbox',
  'TowerFinding',
  'TowerReview',
  'TowerMission',
  'TowerStatus',
] as const;

export class TowerInitTool implements BuiltinTool<TowerInitToolInput> {
  readonly name = 'TowerInit' as const;
  readonly description: string = `Initialize a tower multi-agent workspace in the current repository.

Creates the .tower/ directory (comms state, inbox, findings, reviews, missions, activity log, worktree slots), enters tower mode, and activates the full tower tool set (TowerPlan/TowerSpawn/TowerMerge/TowerTeardown plus the shared TowerSend/TowerInbox/TowerFinding/TowerReview/TowerMission/TowerStatus).

Use this when a task is large enough to split across multiple parallel agents with isolated git worktrees and a review-gated merge protocol. Safe to call again — an existing workspace is reported, never reset.`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerInitToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(_args: TowerInitToolInput): ToolExecution {
    return {
      description: 'Initializing tower workspace',
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newStore(this.agent);
          const result = await store.init();
          this.agent.towerMode.enter();
          this.agent.tools.setActiveTools([
            ...this.agent.tools.getActiveToolNames(),
            ...TOWER_TOOL_NAMES,
          ]);
          return {
            output: [
              result.created
                ? 'tower workspace initialized'
                : 'tower workspace already initialized — existing state preserved',
              `base branch: ${result.base}`,
              'workspace: .tower/ (comms under .tower/comms/, worktrees under .tower/worktrees/)',
              '',
              'Tower mode is active and the tower tool set is enabled.',
              'Next: split the work with TowerPlan (one mission per disjoint file scope), then TowerSpawn a worker per mission. Assign reviewers for their branches, and merge with TowerMerge only after a clean review.',
            ].join('\n'),
          };
        }),
    };
  }
}
