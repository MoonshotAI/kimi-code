import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentTowerService } from '#/features/tower/tower';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { TOWER_NAME } from '#/features/tower/protocol/index';
import { newTowerStore, runTowerTool, TOWER_MAIN_AGENT_ONLY } from '../support';
import DESCRIPTION from './rebase.md?raw';
import { ITowerRebaseTool, TowerRebaseToolInputSchema, type TowerRebaseToolInput } from './rebase';

export class TowerRebaseTool implements ITowerRebaseTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerRebase' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerRebaseToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentTowerService private readonly tower: IAgentTowerService,
  ) {}

  resolveExecution(args: TowerRebaseToolInput): ToolExecution {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) {
      return {
        isError: true,
        output: TOWER_MAIN_AGENT_ONLY,
      };
    }
    return {
      description: `Rebasing tower mission onto base: ${args.mission}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const state = await store.load();
          const mission = state.missions.find((candidate) => candidate.id === args.mission.trim());
          if (mission === undefined) {
            return {
              isError: true,
              output: `unknown mission "${args.mission}" — known: ${state.missions.map((candidate) => candidate.id).join(', ') || '(none)'}`,
            };
          }
          const result = await this.tower.withBranchLease(mission.branch, () =>
            store.rebaseMission(TOWER_NAME, mission.id, {
              activeAgentIds: () => this.activeAgentIds(),
            }),
          );
          if (result.status === 'up-to-date') {
            return {
              output: `mission ${mission.id} (${mission.branch}) is already up to date with base "${state.base}" — retry TowerMerge; if it was refused for another reason, that refusal tells you what is missing`,
            };
          }
          if (result.status === 'conflict') {
            return {
              output: [
                `rebase of mission ${mission.id} (${mission.branch}) onto "${state.base}" conflicted and was aborted — the mission is marked blocked.`,
                `conflicted files: ${result.files?.join(', ') || '(none reported)'}`,
                `resume the worker in the background (foreground only when background task tools are unavailable) so it resolves the conflicts in its worktree and requests a fresh review.`,
              ].join('\n'),
            };
          }
          return {
            output: [
              `rebased mission ${mission.id} (${mission.branch}) onto "${state.base}": ${result.fromCommit!.slice(0, 7)} → ${result.toCommit!.slice(0, 7)}.`,
              'The pre-rebase review keeps its exact-tip binding, but merge approval still requires a clean review with merge verdict "merge" — retry TowerMerge.',
            ].join('\n'),
          };
        }),
    };
  }

  private activeAgentIds(): ReadonlySet<string> {
    return new Set(
      this.tasks
        .list(true)
        .flatMap((task) =>
          task.kind === 'agent' && task.agentId !== undefined ? [task.agentId] : [],
        ),
    );
  }
}
