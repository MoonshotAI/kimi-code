import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
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
          const mission = state.missions.find((m) => m.id === args.mission.trim());
          if (mission === undefined) {
            return {
              isError: true,
              output: `unknown mission "${args.mission}" — known: ${state.missions.map((m) => m.id).join(', ') || '(none)'}`,
            };
          }
          const worker = state.roster.agents.find(
            (agent) => agent.kind === 'worker' && agent.missionId === mission.id,
          );
          const workerRunning =
            worker !== undefined &&
            this.tasks
              .list(true)
              .some((task) => task.kind === 'agent' && task.agentId === worker.agentId);
          if (workerRunning) {
            return {
              isError: true,
              output: `worker "${worker!.name}" is mid-turn — rebasing under a running worker could race its edits; TowerSend it a message asking it to rebase onto ${state.base} when it reaches a stopping point, or retry once it is idle`,
            };
          }
          const result = await store.rebaseMission(TOWER_NAME, mission.id);
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
                `resume the worker (Agent resume with run_in_background=true) so it rebases in its worktree, resolves the conflicts, and requests a re-review.`,
              ].join('\n'),
            };
          }
          return {
            output: [
              `rebased mission ${mission.id} (${mission.branch}) onto "${state.base}": ${result.fromCommit!.slice(0, 7)} → ${result.toCommit!.slice(0, 7)}.`,
              'A clean review on the pre-rebase tip stays valid (conflict-free tower rebase waives the re-review) — retry TowerMerge.',
            ].join('\n'),
          };
        }),
    };
  }
}
