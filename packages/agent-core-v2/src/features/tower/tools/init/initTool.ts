/**
 * `tools` domain — `TowerInitTool` implementation (the `TowerInit` tool).
 *
 * Creates the `.tower/` workspace through the protocol `TowerStore` rooted at
 * the session cwd (`sessionContext`), enters tower mode via `tower`, and
 * activates the tower tool set through `profile`. Idempotent within a
 * session: re-running against an existing workspace reports `created: false`
 * and keeps all state (e.g. after a session resume). Re-running from a
 * *different* session adopts the workspace: roster entries the previous
 * session spawned are retired (their engine agent ids are session-scoped and
 * cannot be resumed here), missions and worktrees are preserved, and the
 * output tells the tower which names were retired so it can respawn.
 * Registered for the main agent only. Bound at Agent scope.
 */

import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentTowerService, TOWER_TOOL_NAMES } from '#/features/tower/tower';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './init.md?raw';
import { ITowerInitTool, TowerInitToolInputSchema, type TowerInitToolInput } from './init';

export class TowerInitTool implements ITowerInitTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerInit' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerInitToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentTowerService private readonly tower: IAgentTowerService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
  ) {}

  resolveExecution(_args: TowerInitToolInput): ToolExecution {
    return {
      description: 'Initializing tower workspace',
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const result = await store.init(this.sessionContext.sessionId);
          this.tower.enter();
          for (const name of TOWER_TOOL_NAMES) this.profile.addActiveTool(name);
          return {
            output: [
              result.created
                ? 'tower workspace initialized'
                : 'tower workspace already initialized — existing state preserved',
              `base branch: ${result.base}`,
              'workspace: .tower/ (comms under .tower/comms/, worktrees under .tower/worktrees/)',
              ...(result.retiredAgents.length > 0
                ? [
                    `adopted from a previous session — retired its stale roster entries: ${result.retiredAgents.join(', ')}. ` +
                      'Their agents belong to the dead session and cannot be resumed; missions and worktrees are preserved — TowerSpawn fresh workers to continue them.',
                  ]
                : []),
              '',
              'Tower mode is active and the tower tool set is enabled.',
              'Next: split the work with TowerPlan (one mission per disjoint file scope), then TowerSpawn a worker per mission. Assign reviewers for their branches, and merge with TowerMerge only after a clean review.',
            ].join('\n'),
          };
        }),
    };
  }
}

