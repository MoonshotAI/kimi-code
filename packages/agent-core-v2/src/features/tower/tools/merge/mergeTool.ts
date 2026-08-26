import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { newTowerStore, runTowerTool, TOWER_MAIN_AGENT_ONLY } from '../support';
import DESCRIPTION from './merge.md?raw';
import { ITowerMergeTool, TowerMergeToolInputSchema, type TowerMergeToolInput } from './merge';

export class TowerMergeTool implements ITowerMergeTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerMerge' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerMergeToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: TowerMergeToolInput): ToolExecution {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) {
      return {
        isError: true,
        output: TOWER_MAIN_AGENT_ONLY,
      };
    }
    return {
      description: `Merging tower branch: ${args.branch}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
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

