import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IAgentTowerService } from '#/features/tower/tower';
import { TowerProtocolError } from '#/features/tower/protocol/index';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { newTowerStore, runTowerTool, TOWER_MAIN_AGENT_ONLY } from '../support';
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
    @ISessionManager private readonly sessions: ISessionManager,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(_args: TowerInitToolInput): ToolExecution {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) {
      return {
        isError: true,
        output: TOWER_MAIN_AGENT_ONLY,
      };
    }
    return {
      description: 'Initializing tower workspace',
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const priorOwner = await store.load().then(
            (state) => state.sessionId,
            () => undefined,
          );
          if (
            priorOwner !== undefined &&
            priorOwner !== this.sessionContext.sessionId &&
            this.sessions.get(priorOwner) !== undefined
          ) {
            throw new TowerProtocolError(
              `tower workspace is owned by a live session (${priorOwner}) — adopting it would retire that session's roster. Use the tower from that session, or close it first.`,
            );
          }
          const result = await store.init(this.sessionContext.sessionId);
          await this.tower.enter();
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
