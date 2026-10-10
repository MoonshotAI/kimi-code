import { ILogService } from '#/_base/log/log';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { subagentParentAgentId } from '#/session/agentLifecycle/subagentMetadata';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ToolExecution } from '#/tool/toolContract';
import { notifyUserAvailable } from '../../notifyUserAvailability';
import { notifyStreakBefore } from '../../notifyUserNudge';
import { SubagentUpdate } from '../../subagentUpdate';

import {
  INotifyUserTool,
  NOTIFY_USER_DELIVERED_OUTPUT,
  NOTIFY_USER_EMPTY_MESSAGE,
  NOTIFY_USER_EMPTY_TITLE,
  NOTIFY_USER_SUPPRESSED_OUTPUT,
  NOTIFY_USER_TOOL_NAME,
  NotifyUserInputSchema,
  type NotifyUserInput,
} from './notify-user';
import DESCRIPTION from './notify-user.md?raw';

export class NotifyUserTool implements INotifyUserTool {
  declare readonly _serviceBrand: undefined;
  readonly name = NOTIFY_USER_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(NotifyUserInputSchema);

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ILogService private readonly log: ILogService,
  ) {}

  resolveExecution(args: NotifyUserInput): ToolExecution {
    if (args.title.trim().length === 0) {
      return { isError: true, output: NOTIFY_USER_EMPTY_TITLE };
    }
    if (args.message.trim().length === 0) {
      return { isError: true, output: NOTIFY_USER_EMPTY_MESSAGE };
    }
    return {
      description: 'Notifying the user',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async ({ turnId, toolCallId }) => {
        const displayed = notifyUserAvailable(this.flags, this.bootstrap);
        const streak = notifyStreakBefore(this.context.get(), toolCallId);
        this.telemetry.track2('notify_user_sent', {
          turn_id: turnId,
          rounds_since_notify: streak.rounds,
          after_nudge: streak.nudges > 0,
          title_chars: args.title.length,
          message_chars: args.message.length,
          displayed,
        });
        if (!displayed) return { isError: false, output: NOTIFY_USER_SUPPRESSED_OUTPUT };
        await this.forwardToParent(args);
        return { isError: false, output: NOTIFY_USER_DELIVERED_OUTPUT };
      },
    };
  }

  private async forwardToParent(args: NotifyUserInput): Promise<void> {
    const subagentId = this.scope.agentId;
    try {
      const meta = await this.metadata.read();
      const parentAgentId = subagentParentAgentId(meta.agents?.[subagentId]);
      if (parentAgentId === undefined) return;
      const dispatcher = this.agents.handleOf(parentAgentId)?.accessor.get(IEventDispatcher);
      await dispatcher?.dispatch(
        new SubagentUpdate({ subagentId, title: args.title.trim(), message: args.message }),
      );
    } catch (error) {
      this.log.warn('notify-user: could not forward the update to the parent agent', {
        subagentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
