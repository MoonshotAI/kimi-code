/**
 * `tools` domain — `TowerInitTool` implementation (the `TowerInit` tool).
 *
 * Creates the `.tower/` workspace through the protocol `TowerStore` rooted at
 * the session cwd (`sessionContext`), enters tower mode via `tower`, and
 * activates the tower tool set through `profile`. Idempotent: re-running
 * against an existing workspace reports `created: false`, keeps all state,
 * and simply re-enters mode and re-enables the tools (e.g. after a session
 * resume). Registered for the main agent only. Bound at Agent scope.
 */

import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentTowerService, TOWER_TOOL_NAMES } from '#/agent/tower/tower';
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
          const result = await store.init();
          this.tower.enter();
          this.profile.activateTools(TOWER_TOOL_NAMES);
          return {
            output: [
              result.created
                ? 'tower workspace initialized'
                : 'tower workspace already initialized — existing state preserved',
              `base branch: ${result.base}`,
              'workspace: .tower/ (comms under .tower/comms/, worktrees under .tower/worktrees/)',
              '',
              'Tower mode is active and the tower tool set is enabled.',
              'Next: split the work with TowerPlan (one mission per disjoint file scope), then TowerSpawn a worker per mission. Assign reviewers for their branches, and merge with TowerMerge only after a clean review.',
            ].join('\n'),
          };
        }),
    };
  }
}

registerAgentToolService(ITowerInitTool, TowerInitTool, {
  name: 'TowerInit',
  domain: 'tower',
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
