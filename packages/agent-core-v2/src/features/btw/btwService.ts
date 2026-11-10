import { Disposable } from '#/_base/di/lifecycle';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import {
  BTW_AGENT_LABEL,
  BTW_READONLY_TOOLS,
  ISessionBtwService,
  SIDE_QUESTION_SYSTEM_REMINDER,
  TOOL_CALL_DISABLED_MESSAGE,
} from './btw';

export class SessionBtwService extends Disposable implements ISessionBtwService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {
    super();
    this._register(
      this.agentLifecycle.onDidCreateScope(({ meta, handle }) => {
        if (meta?.labels?.[BTW_AGENT_LABEL] !== 'true') return;
        const reason =
          handle.accessor.get(IAgentToolApprovalService)?.formatDenyMessage(
            TOOL_CALL_DISABLED_MESSAGE,
          ) ?? TOOL_CALL_DISABLED_MESSAGE;
        handle.accessor.get(IAgentToolExecutorService)?.onBeforeExecuteTool((event) => {
          if (!BTW_READONLY_TOOLS.has(event.toolCall.name)) {
            event.veto(denyToolExecution(reason));
          }
        });
      }),
    );
  }

  async start(): Promise<string> {
    const main = this.agentLifecycle.handleOf(MAIN_AGENT_ID);
    if (main === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
    }
    const childContext = await this.agentLifecycle.fork(
      main.accessor.get(IAgentScopeContext).agentContext,
      { labels: { [BTW_AGENT_LABEL]: 'true' } },
    );
    const child = this.agentLifecycle.handleOf(childContext.agentId)!;
    child.accessor
      .get(IAgentReminderService)
      .notify(SIDE_QUESTION_SYSTEM_REMINDER, { variant: 'btw' });
    return childContext.agentId;
  }
}
