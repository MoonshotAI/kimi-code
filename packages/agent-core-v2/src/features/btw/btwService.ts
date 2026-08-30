import { denyToolExecution } from '#/actor/toolExecutor/toolHooks';
import { AgentReminder } from '#/actor/reminder/reminderAgentRuntime';
import { AgentTools } from '#/actor/toolExecutor/toolExecutorAgentRuntime';
import { ISessionBtwService, SIDE_QUESTION_SYSTEM_REMINDER, TOOL_CALL_DISABLED_MESSAGE } from './btw';
import { ErrorCodes, Error2 } from '#/errors';
import { ISessionToolApprovalService } from '#/agent/toolApproval/sessionToolApprovalService';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';



export class SessionBtwService implements ISessionBtwService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @ISessionToolApprovalService private readonly toolApproval: ISessionToolApprovalService,
  ) {}

  async start(): Promise<string> {
    const main = this.agentLifecycle.get(MAIN_AGENT_ID);
    if (main === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
    }
    const childContext = await this.agentLifecycle.fork(main);
    this.agentLifecycle
      .resolve(childContext, AgentReminder)
      .notify(SIDE_QUESTION_SYSTEM_REMINDER, { variant: 'btw' });
    const reason = this.toolApproval.of(childContext).formatDenyMessage(TOOL_CALL_DISABLED_MESSAGE);
    this.agentLifecycle
      .resolve(childContext, AgentTools)
      .participateExecution('btw', (event) => {
        event.veto(denyToolExecution(reason));
      });
    return childContext.agentId;
  }
}
