import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { ISessionBtwService, SIDE_QUESTION_SYSTEM_REMINDER, TOOL_CALL_DISABLED_MESSAGE } from './btw';

export class SessionBtwService implements ISessionBtwService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
  ) {}

  async start(): Promise<string> {
    const child = await this.lifecycle.fork('main');
    child.accessor
      .get(IAgentSystemReminderService)
      ?.appendSystemReminder(SIDE_QUESTION_SYSTEM_REMINDER, {
        kind: 'injection',
        variant: 'btw',
      });
    const reason =
      child.accessor.get(IAgentToolApprovalService)?.formatDenyMessage(
        TOOL_CALL_DISABLED_MESSAGE,
      ) ?? TOOL_CALL_DISABLED_MESSAGE;
    child.accessor
      .get(IAgentToolExecutorService)
      ?.onBeforeExecuteTool((event) => {
        event.veto(denyToolExecution(reason));
      });
    return child.id;
  }
}
