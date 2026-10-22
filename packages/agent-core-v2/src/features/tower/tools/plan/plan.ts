import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const TowerPlanToolInputSchema = z
  .object({
    missions: z
      .array(
        z
          .object({
            title: z
              .string()
              .describe(
                'Short mission title; becomes the branch/worktree slug. Printable ASCII English only — any non-ASCII character is rejected. Include a unique identifier word (a business code, a module name, a ticket id).',
              ),
            scope: z
              .array(z.string())
              .min(1)
              .describe(
                'Files/globs this mission may touch (e.g. "src/build/**"). Scopes of different build and artifact missions should be disjoint; when they overlap, the store auto-adds a dependency that serializes their merges. Survey scopes are informational and reserve nothing.',
              ),
            tasks: z
              .array(z.string())
              .optional()
              .describe(
                'Checklist the worker will tick off via TowerMission task_done — write each task as a verifiable item a reviewer or the human acceptance step can map to the diff',
              ),
            context: z
              .string()
              .optional()
              .describe(
                "The user's own key sentences about this mission, copied verbatim — the tower's paraphrase supplements them, never replaces them. Fill this whenever the requirement could be misread; never paste the full conversation history.",
              ),
            deps: z
              .array(z.string())
              .optional()
              .describe('Mission ids (e.g. "M1") that must merge before this one can merge'),
            kind: z
              .enum(['build', 'survey', 'artifact'])
              .optional()
              .describe(
                '"survey" = read-only investigation: the scope is informational and reserves nothing (other missions may overlap it), the worker must not change code, and closing it needs no review or git merge. "artifact" = committed deliverables in a reserved scope: no independent reviewer, but explicit human acceptance is required before a real merge. Default "build".',
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
