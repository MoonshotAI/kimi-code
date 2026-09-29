import { z } from 'zod';

import { MAIN_AGENT_ID, type ToolDefinition } from '@moonshot-ai/agent-core';

import DESCRIPTION from './plan.md?raw';
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
              .describe(
                'Checklist the worker will tick off via TowerMission task_done — write each task as a verifiable item a reviewer can map to the diff',
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

export function createTowerPlanTool(deps: TowerToolDeps): ToolDefinition {
  return {
    name: 'TowerPlan',
    description: DESCRIPTION,
    parameters: toInputJsonSchema(TowerPlanToolInputSchema),
    execute({ toolCall }) {
      if (deps.agentId !== MAIN_AGENT_ID) {
        return Promise.resolve(errorText(TOWER_MAIN_AGENT_ONLY));
      }
      const parsed = parseTowerArgs(TowerPlanToolInputSchema, toolCall.arguments, 'TowerPlan');
      if ('parseError' in parsed) return Promise.resolve(errorText(parsed.parseError));
      const args = parsed.args;
      return runTowerTool(async () => {
        if (!deps.isActive()) {
          return errorText(TOWER_MODE_USER_ENABLED_ONLY);
        }
        const store = newTowerStore(deps);
        const missions = await store.plan(args.missions);
        const rows = missions.map(
          (m) =>
            `| ${m.id} | ${m.title} | ${m.kind} | ${m.branch} | ${m.worktree} | ${m.scope.join(', ')} |`,
        );
        return text(
          [
            `planned ${String(missions.length)} mission(s):`,
            '',
            '| ID | Mission | Kind | Branch | Worktree | Scope |',
            '| -- | ------- | ---- | ------ | -------- | ----- |',
            ...rows,
            '',
            'Next: TowerSpawn one worker per mission (workers get their worktree path and mission briefing automatically), plus reviewers for the branches. Survey missions need no reviewer — they close with a zero-diff TowerMerge.',
          ].join('\n'),
        );
      });
    },
  };
}
