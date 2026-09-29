import { z } from 'zod';

import { MAIN_AGENT_ID, type ToolDefinition } from '@moonshot-ai/agent-core';

import DESCRIPTION from './merge.md?raw';
import {
  errorText,
  newTowerStore,
  parseTowerArgs,
  runTowerTool,
  text,
  toInputJsonSchema,
  TOWER_MAIN_AGENT_ONLY,
  type TowerToolDeps,
} from './support';

export const TowerMergeToolInputSchema = z
  .object({
    branch: z
      .string()
      .describe('The mission branch to merge into the base branch (e.g. "feat/vulkan-build")'),
  })
  .strict();

export type TowerMergeToolInput = z.infer<typeof TowerMergeToolInputSchema>;

export function createTowerMergeTool(deps: TowerToolDeps): ToolDefinition {
  return {
    name: 'TowerMerge',
    description: DESCRIPTION,
    parameters: toInputJsonSchema(TowerMergeToolInputSchema),
    execute({ toolCall }) {
      if (deps.agentId !== MAIN_AGENT_ID) {
        return Promise.resolve(errorText(TOWER_MAIN_AGENT_ONLY));
      }
      const parsed = parseTowerArgs(TowerMergeToolInputSchema, toolCall.arguments, 'TowerMerge');
      if ('parseError' in parsed) return Promise.resolve(errorText(parsed.parseError));
      const args = parsed.args;
      return runTowerTool(async () => {
        const store = newTowerStore(deps);
        const { mergeCommit, conflictsWith, noop } = await store.merge(args.branch);
        if (noop === true) {
          return text(
            [
              `${args.branch} is a read-only survey with a zero-diff branch — mission marked merged, no git merge needed.`,
              'Continue with the remaining missions in Dependency Flow order.',
            ].join('\n'),
          );
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
            'Tell each affected worker (Agent resume with run_in_background=true — never foreground: their output flows back through the tower protocol files) to rebase onto the updated base, resolve, push, and request a re-review.',
          );
        } else {
          lines.push('The mission is now marked merged. Continue with the remaining missions in Dependency Flow order.');
        }
        return text(lines.join('\n'));
      });
    },
  };
}
