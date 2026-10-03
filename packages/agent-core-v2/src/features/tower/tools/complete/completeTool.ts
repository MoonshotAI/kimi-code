import { IAgentScopeContext, agentContextOfScope } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionEventBus } from '#/app/event/eventBus';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { deliverTowerMessage } from '../delivery';
import { callerTokens, newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './complete.md?raw';
import {
  ITowerCompleteTool,
  TowerCompleteToolInputSchema,
  type TowerCompleteToolInput,
} from './complete';

export class TowerCompleteTool implements ITowerCompleteTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerComplete' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerCompleteToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionUsageService private readonly usage: ISessionUsageService,
    @ISessionEventBus private readonly sessionBus: ISessionEventBus,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {}

  resolveExecution(args: TowerCompleteToolInput): ToolExecution {
    return {
      description: 'Completing tower mission and storing its notification',
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const resolved = await store.resolveMessagingCaller(
            await store.loadOrRecover(),
            this.scopeContext.agentId,
          );
          const result = await store.complete(
            resolved.caller,
            args.report.trim(),
            callerTokens(this.usage, agentContextOfScope(this.scopeContext)),
          );
          const delivery =
            result.message !== undefined
              ? deliverTowerMessage(
                  {
                    sessionBus: this.sessionBus,
                    tasks: this.tasks,
                    agentLifecycle: this.agentLifecycle,
                    state: resolved.state,
                  },
                  result.message,
                )
              : '';
          const lines: string[] = [];
          if (result.mission === undefined) {
            lines.push(
              `the tower state was recovered at ${result.recoveredAt ?? 'an unknown time'} after a loss — your mission record is gone, so no mission was marked completed and nothing pretends otherwise`,
            );
            if (result.message !== undefined) {
              lines.push(
                `your report was still delivered to the tower as a ${result.message.item.subject} message: ${result.message.item.file}`,
                result.notificationCreated
                  ? 'notification: stored once'
                  : 'notification: reused the stored message; no duplicate was written',
              );
            }
          } else {
            lines.push(`mission ${result.mission.id} persisted as ${result.mission.status}`);
            if (result.message !== undefined) {
              lines.push(
                `${result.message.item.subject} notification: ${result.message.item.file}`,
                result.notificationCreated
                  ? 'notification: stored once'
                  : 'notification: reused the stored message; no duplicate was written',
              );
            }
          }
          if (result.notificationError !== undefined) {
            lines.push(`notification error: ${result.notificationError}`);
          }
          if (result.activityLogError !== undefined) {
            lines.push(`activity log error: ${result.activityLogError}`);
          }
          if (delivery.length > 0) lines.push(delivery);
          return {
            output: lines.join('\n'),
            isError:
              result.notificationError === undefined && result.activityLogError === undefined
                ? undefined
                : true,
          };
        }),
    };
  }
}
