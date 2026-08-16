/**
 * `tools` domain — `ITowerSpawnTool` contract (the `TowerSpawn` tool).
 *
 * Public contract of the tower's worker/reviewer launcher: the input schema
 * (verbatim port of v1 — worker spawns require `mission_id`, reviewer spawns
 * require `review_target`) and the `ITowerSpawnTool` DI decorator. Bound at
 * Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerSpawnToolInputSchema = z
  .object({
    name: z
      .string()
      .describe(
        'Unique tower name for the agent (e.g. "agent-build", "reviewer-a"). Used for inbox addressing and mission ownership.',
      ),
    kind: z
      .enum(['worker', 'reviewer'])
      .describe('workers execute a mission in their worktree; reviewers review one branch'),
    mission_id: z
      .string()
      .optional()
      .describe('Required for workers: the mission id (e.g. "M1") from TowerPlan'),
    review_target: z
      .string()
      .optional()
      .describe('Required for reviewers: the branch to review (e.g. "feat/vulkan-build")'),
    instructions: z
      .string()
      .optional()
      .describe('Extra tower instructions appended to the generated briefing'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'worker' && (value.mission_id ?? '').trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mission_id'],
        message: 'worker spawns require mission_id',
      });
    }
    if (value.kind === 'reviewer' && (value.review_target ?? '').trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['review_target'],
        message: 'reviewer spawns require review_target',
      });
    }
  });

export type TowerSpawnToolInput = z.infer<typeof TowerSpawnToolInputSchema>;

export interface ITowerSpawnTool extends AgentTool<TowerSpawnToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerSpawnTool = createDecorator<ITowerSpawnTool>('towerSpawnTool');
