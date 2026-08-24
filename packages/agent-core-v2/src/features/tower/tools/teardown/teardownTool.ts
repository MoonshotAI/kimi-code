import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IAgentTowerService } from '#/features/tower/tower';
import { TowerProtocolError } from '#/features/tower/protocol/index';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { newTowerStore, runTowerTool, TOWER_MAIN_AGENT_ONLY } from '../support';
import DESCRIPTION from './teardown.md?raw';
import {
  ITowerTeardownTool,
  TowerTeardownToolInputSchema,
  type TowerTeardownToolInput,
} from './teardown';

export class TowerTeardownTool implements ITowerTeardownTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerTeardown' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerTeardownToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentTowerService private readonly tower: IAgentTowerService,
    @ISessionManager private readonly sessions: ISessionManager,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: TowerTeardownToolInput): ToolExecution {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) {
      return {
        isError: true,
        output: TOWER_MAIN_AGENT_ONLY,
      };
    }
    return {
      description: `Tearing down tower workspace${args.force === true ? ' (force)' : ''}`,
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
              `tower workspace is owned by a live session (${priorOwner}) — tearing it down would dismantle that session's fleet. Use TowerTeardown from that session, or close it first.`,
            );
          }
          const report = await store.teardown({ force: args.force });
          this.tower.exit();
          return {
            output: [
              'tower teardown:',
              ...report.map((line) => `- ${line}`),
              '',
              'Tower mode exited. .tower/comms/ (state, inbox, findings, reviews, activity log) is kept as the audit trail — remove it by hand only if you are sure.',
            ].join('\n'),
          };
        }),
    };
  }
}
