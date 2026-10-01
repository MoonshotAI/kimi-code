import { IAgentScopeContext, agentContextOfScope } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionEventBus } from '#/app/event/eventBus';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { deliverTowerMessage } from '../delivery';
import { callerName, callerTokens, newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './send.md?raw';
import { ITowerSendTool, TowerSendToolInputSchema, type TowerSendToolInput } from './send';

export class TowerSendTool implements ITowerSendTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerSend' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerSendToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionEventBus private readonly sessionBus: ISessionEventBus,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {}

  resolveExecution(args: TowerSendToolInput): ToolExecution {
    return {
      description: `Sending tower message to ${args.to}: ${args.subject}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const state = await store.load();
          const caller = callerName(this.scopeContext.agentId, store, state);
          const to = args.to.trim();
          const sent = await store.sendDetailed(caller, {
            to,
            subject: args.subject,
            body: args.body,
            scope: args.scope,
            action: args.action,
            consentRef: args.consent_ref,
            tokens: callerTokens(this.usage, agentContextOfScope(this.scopeContext)),
          });
          const delivery = deliverTowerMessage(
            {
              sessionBus: this.sessionBus,
              tasks: this.tasks,
              agentLifecycle: this.agentLifecycle,
              state,
            },
            sent,
          );
          const lines = [`message sent to ${args.to}\nfile: ${sent.item.file}${delivery}`];
          if (sent.activityLogError !== undefined) {
            lines.push(`activity log error: ${sent.activityLogError}`);
          }
          return {
            output: lines.join('\n'),
            isError: sent.activityLogError === undefined ? undefined : true,
          };
        }),
    };
  }
}

