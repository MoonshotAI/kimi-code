import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionEventBus } from '#/app/event/eventBus';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { deliverTowerMessage } from '../delivery';
import { callerName, newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './review.md?raw';
import {
  ITowerReviewTool,
  TowerReviewToolInputSchema,
  type TowerReviewToolInput,
} from './review';

export class TowerReviewTool implements ITowerReviewTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerReview' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerReviewToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionEventBus private readonly sessionBus: ISessionEventBus,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {}

  resolveExecution(args: TowerReviewToolInput): ToolExecution {
    return {
      description: `Submitting tower review for ${args.target}: ${args.status}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const state = await store.load();
          const caller = callerName(this.scopeContext.agentId, store, state);
          const result = await store.submitReview(caller, {
            target: args.target,
            status: args.status,
            merge: args.merge,
            findings: args.findings,
            checks: args.checks,
            decision: args.decision,
          });
          const delivery = result.storedMessages
            .map((message) =>
              deliverTowerMessage(
                {
                  sessionBus: this.sessionBus,
                  tasks: this.tasks,
                  agentLifecycle: this.agentLifecycle,
                  state,
                },
                message,
              ),
            )
            .join('');
          const notified = result.storedMessages.map((message) => message.item.to);
          const lines = [
            `review submitted: ${result.review.file}`,
            `notified: ${notified.length > 0 ? notified.join(', ') : '(none)'}`,
          ];
          if (result.notificationError !== undefined) {
            lines.push(`notification error: ${result.notificationError}`);
          }
          if (result.activityLogError !== undefined) {
            lines.push(`activity log error: ${result.activityLogError}`);
          }
          if (args.status === 'clean' && args.merge === 'merge') {
            lines.push(
              `next: ${args.target} is merge-ready — the tower can TowerMerge it in Dependency Flow order.`,
            );
          } else if (args.status === 'clean') {
            lines.push(
              args.merge === 'hold'
                ? `next: ${args.target} is blocked by the latest review's "hold" verdict — the merge gate rejects it; do not TowerMerge until a later clean review with merge verdict "merge" supersedes it.`
                : `next: ${args.target} is not merge-approved — "fix-then-merge" is not approval; the merge gate requires a clean review with merge verdict "merge" before TowerMerge.`,
            );
          } else {
            lines.push(
              `next: ${args.target} is not merge-ready — the gate requires a clean review with merge verdict "merge" on the exact tip; the author must fix and re-review.`,
            );
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

