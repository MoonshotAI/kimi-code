import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ErrorCodes, Error2 } from '#/errors';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import { ISessionBtwService, SIDE_QUESTION_SYSTEM_REMINDER, TOOL_CALL_DISABLED_MESSAGE } from './btw';

export class SessionBtwService implements ISessionBtwService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
  ) {}

  async start(): Promise<string> {
    const main = this.agentLifecycle.handleOf(MAIN_AGENT_ID);
    if (main === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
    }
    const childContext = await this.agentLifecycle.fork(main.accessor.get(IAgentScopeContext).agentContext);
    const child = this.agentLifecycle.handleOf(childContext.agentId)!;
    child.accessor
      .get(IAgentReminderService)
      .notify(SIDE_QUESTION_SYSTEM_REMINDER, { variant: 'btw' });
    const reason =
      child.accessor.get(IAgentToolApprovalService)?.formatDenyMessage(
        TOOL_CALL_DISABLED_MESSAGE,
      ) ?? TOOL_CALL_DISABLED_MESSAGE;
    child.accessor
      .get(IAgentToolExecutorService)
      ?.onBeforeExecuteTool((event) => {
        event.veto(denyToolExecution(reason));
      });
    return childContext.agentId;
  }
}
