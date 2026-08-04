/**
 * TowerMergeTool — the tower's merge lever. The store is the hard gate: it
 * refuses when the branch has no review, the latest review is not clean, the
 * branch tip moved since the clean review, dependencies are unmerged, or the
 * branch changed files outside its mission scope. After a successful merge it
 * reports which unmerged branches touched the same files (they must rebase —
 * their moved tip then fails the reviewed_commit gate, forcing a re-review).
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { newStore, runTowerTool } from './support';

export const TowerMergeToolInputSchema = z
  .object({
    branch: z
      .string()
      .describe('The mission branch to merge into the base branch (e.g. "feat/vulkan-build")'),
  })
  .strict();

export type TowerMergeToolInput = z.infer<typeof TowerMergeToolInputSchema>;

export class TowerMergeTool implements BuiltinTool<TowerMergeToolInput> {
  readonly name = 'TowerMerge' as const;
  readonly description: string = `Merge a tower mission branch into the base branch (--no-ff).

Hard gate, enforced by the store — the merge is refused unless: the branch's latest review is "clean" and was written against the current branch tip, all dependency missions are already merged, and every changed file falls inside the mission's declared scope. On refusal, the error message tells you exactly what to do next (assign a reviewer, wait for fixes, re-review a moved tip, merge deps first, widen the scope or revert the extra changes). After a merge, branches reported as conflicting must rebase onto the new base and be re-reviewed before they can merge.`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerMergeToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: TowerMergeToolInput): ToolExecution {
    return {
      description: `Merging tower branch: ${args.branch}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newStore(this.agent);
          const { mergeCommit, conflictsWith, noop } = await store.merge(args.branch);
          if (noop === true) {
            return {
              output: [
                `${args.branch} is a read-only survey with a zero-diff branch — mission marked merged, no git merge needed.`,
                'Continue with the remaining missions in Dependency Flow order.',
              ].join('\n'),
            };
          }
          const lines = [
            `merged ${args.branch} (merge commit ${mergeCommit.slice(0, 7)})`,
            `full commit: ${mergeCommit}`,
          ];
          if (conflictsWith.length > 0) {
            lines.push(
              '',
              'These unmerged branches changed the same files and now likely conflict with the base:',
              ...conflictsWith.map(
                (conflict) => `- ${conflict.branch}: ${conflict.files.join(', ')}`,
              ),
              'Tell each affected worker (Agent resume) to rebase onto the updated base, resolve, push, and request a re-review.',
            );
          } else {
            lines.push('The mission is now marked merged. Continue with the remaining missions in Dependency Flow order.');
          }
          return { output: lines.join('\n') };
        }),
    };
  }
}
