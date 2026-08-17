/**
 * `tools` domain — `ITowerPlanTool` contract (the `TowerPlan` tool).
 *
 * Public contract of the tower's mission splitter: each mission gets an id,
 * a branch, and a worktree slot; scopes must be pairwise disjoint and deps
 * must reference known mission ids (both enforced by the store). Exports the
 * model-facing `TowerPlanToolInputSchema` / `TowerPlanToolInput` and the
 * `ITowerPlanTool` DI decorator. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerPlanToolInputSchema = z
  .object({
    missions: z
      .array(
        z
          .object({
            title: z.string().describe('Short mission title; becomes the branch/worktree slug'),
            scope: z
              .array(z.string())
              .min(1)
              .describe(
                'Files/globs this mission may touch (e.g. "src/build/**"). Scopes of different missions must not overlap.',
              ),
            tasks: z
              .array(z.string())
              .optional()
              .describe('Checklist the worker will tick off via TowerMission task_done'),
            deps: z
              .array(z.string())
              .optional()
              .describe('Mission ids (e.g. "M1") that must merge before this one can merge'),
            kind: z
              .enum(['build', 'survey'])
              .optional()
              .describe(
                '"survey" = read-only investigation: the scope is informational and reserves nothing (other missions may overlap it), the worker must not change code, and closing it needs no review or git merge. Default "build".',
              ),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type TowerPlanToolInput = z.infer<typeof TowerPlanToolInputSchema>;

export interface ITowerPlanTool extends AgentTool<TowerPlanToolInput> {
  readonly _serviceBrand: undefined;
}
export const ITowerPlanTool = createDecorator<ITowerPlanTool>('towerPlanTool');
