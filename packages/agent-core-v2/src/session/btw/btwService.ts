/**
 * `btw` domain — `ISessionBtwService` implementation.
 *
 * Forks the main agent into a side-question child: inherits profile/context via
 * `IAgentLifecycleService.fork`, then disables tool calls via an
 * `onBeforeExecuteTool` veto listener (blocks every tool call with the
 * `toolApproval.formatDenyMessage`-formatted TOOL_CALL_DISABLED_MESSAGE) and
 * appends the side-channel system reminder. Bound at Session scope —
 * `fork('main')` is a session-level operation, so the service injects the
 * session's `IAgentLifecycleService` directly rather than resolving it through
 * the main agent's accessor. Callers materialize the main agent first (the
 * route resumes the session); forking a missing source throws.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
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
        kind: 'system_trigger',
        name: 'btw',
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

registerScopedService(
  LifecycleScope.Session,
  ISessionBtwService,
  SessionBtwService,
  InstantiationType.Eager,
  'session-btw',
);
