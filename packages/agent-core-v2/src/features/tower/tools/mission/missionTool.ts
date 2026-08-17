/**
 * `tools` domain — `TowerMissionTool` implementation (the `TowerMission`
 * tool).
 *
 * Reads and patches missions through the protocol `TowerStore` rooted at the
 * session cwd (`sessionContext`), resolving the caller's roster identity
 * from the agent scope (`scopeContext`). Registered for every agent —
 * visibility is controlled by profile tool lists. Bound at Agent scope.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MISSIONS_DIR, missionFileName } from '#/features/tower/protocol/index';
import type { TowerMission, TowerStore } from '#/features/tower/protocol/index';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { callerName, newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './mission.md?raw';
import {
  ITowerMissionTool,
  TowerMissionToolInputSchema,
  type TowerMissionToolInput,
} from './mission';

export class TowerMissionTool implements ITowerMissionTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerMission' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerMissionToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: TowerMissionToolInput): ToolExecution {
    const hasPatch =
      args.status !== undefined ||
      args.note !== undefined ||
      args.blocker !== undefined ||
      args.clear_blockers !== undefined ||
      args.task_done !== undefined ||
      args.scope !== undefined;
    return {
      description: hasPatch
        ? `Updating tower mission ${args.id}`
        : `Reading tower mission ${args.id}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const state = await store.load();
          const caller = callerName(this.scopeContext.agentId, store, state);
          if (!hasPatch) {
            const mission = state.missions.find((m) => m.id === args.id);
            if (mission === undefined) {
              const known = state.missions.map((m) => m.id).join(', ');
              return {
                output: `unknown mission "${args.id}" — known missions: ${known.length > 0 ? known : '(none planned yet)'}`,
                isError: true,
              };
            }
            return { output: await renderMission(store, mission) };
          }
          const mission = await store.updateMission(caller, args.id, {
            status: args.status,
            note: args.note,
            blocker: args.blocker,
            clearBlockers: args.clear_blockers,
            taskDone: args.task_done,
            scope: args.scope,
          });
          return {
            output: [
              `mission ${mission.id} updated — status: ${mission.status}, open tasks: ${String(mission.tasks.filter((t) => !t.done).length)}, blockers: ${String(mission.blockers.length)}`,
              '',
              await renderMission(store, mission),
            ].join('\n'),
          };
        }),
    };
  }
}

async function renderMission(store: TowerStore, mission: TowerMission): Promise<string> {
  return readFile(
    store.abs(join(MISSIONS_DIR, missionFileName(mission.id, mission.slug))),
    'utf8',
  );
}

