/**
 * TowerPlanTool — the tower's mission splitter. Each mission gets an id, a
 * branch, and a worktree slot; scopes must be pairwise disjoint and deps must
 * reference known mission ids (both enforced by the store).
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { newStore, runTowerTool } from './support';

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

export class TowerPlanTool implements BuiltinTool<TowerPlanToolInput> {
  readonly name = 'TowerPlan' as const;
  readonly description: string = `Split the tower goal into missions. Each mission gets an id (M1, M2, …), a branch (feat/<slug>), and an isolated git worktree (.tower/worktrees/wt-N).

Rules enforced by the store: scopes of build missions must be pairwise disjoint (survey missions are read-only and reserve no scope), and deps must reference existing mission ids. Plan once, then spawn one worker per mission with TowerSpawn. Requires an active tower workspace (run TowerInit first).`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerPlanToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: TowerPlanToolInput): ToolExecution {
    return {
      description: `Planning ${String(args.missions.length)} tower mission(s)`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          if (!this.agent.towerMode.isActive) {
            return {
              output: 'tower mode is not active — run TowerInit first',
              isError: true,
            };
          }
          const store = newStore(this.agent);
          const missions = await store.plan(args.missions);
          const rows = missions.map(
            (m) =>
              `| ${m.id} | ${m.title} | ${m.kind} | ${m.branch} | ${m.worktree} | ${m.scope.join(', ')} |`,
          );
          return {
            output: [
              `planned ${String(missions.length)} mission(s):`,
              '',
              '| ID | Mission | Kind | Branch | Worktree | Scope |',
              '| -- | ------- | ---- | ------ | -------- | ----- |',
              ...rows,
              '',
              'Next: TowerSpawn one worker per mission (workers get their worktree path and mission briefing automatically), plus reviewers for the branches. Survey missions need no reviewer — they close with a zero-diff TowerMerge.',
            ].join('\n'),
          };
        }),
    };
  }
}
