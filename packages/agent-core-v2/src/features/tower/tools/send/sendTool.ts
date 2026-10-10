import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionEventBus } from '#/app/event/eventBus';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { deliverTowerMessage } from '../delivery';
import { newTowerStore, runTowerTool } from '../support';
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
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {}

  resolveExecution(args: TowerSendToolInput): ToolExecution {
    return {
      description: `Sending tower message to ${args.to}: ${args.subject}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const resolved = await store.resolveMessagingCaller(
            await store.loadOrRecover(),
            this.scopeContext.agentId,
          );
          const caller = resolved.caller;
          const to = args.to.trim();
          const sent = await store.sendDetailed(caller, {
            to,
            subject: args.subject,
            body: args.body,
            scope: args.scope,
            action: args.action,
            consentRef: args.consent_ref,
          });
          const delivery = deliverTowerMessage(
            {
              sessionBus: this.sessionBus,
              tasks: this.tasks,
              agentLifecycle: this.agentLifecycle,
              state: resolved.state,
            },
            sent,
          );
          const lines = [`message sent to ${args.to}\nfile: ${sent.item.file}${delivery}`];
          if (resolved.placeholder === true) {
            lines.push(
              `note: the tower state was recovered after a loss, so your roster entry was reconstructed as placeholder "${caller}" — your original name and mission assignment are gone; the recovered state's recoveredAt marker reminds the tower to report the history loss to the user`,
            );
          }
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

