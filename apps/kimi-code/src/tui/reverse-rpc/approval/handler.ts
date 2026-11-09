import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from '@moonshot-ai/kimi-code-sdk';

import { adaptApprovalRequest } from './adapter';
import { MAIN_AGENT_ID } from '#/tui/constant/kimi-tui';
import type { ProgramStatusInteractionTracker } from '#/tui/controllers/program-status';
import { isToolCallId, type TurnTimeline } from '#/tui/utils/turn-timeline';

import type { ApprovalController } from './controller';

export function createApprovalRequestHandler(
  controller: ApprovalController,
  onResponse?: (request: ApprovalRequest, response: ApprovalResponse) => void,
  resolveEnvironment?: () => string | undefined,
  interactionTracker?: ProgramStatusInteractionTracker,
  timeline?: Pick<TurnTimeline, 'approvalRequested'>,
): ApprovalHandler {
  return async (event: ApprovalRequest): Promise<ApprovalResponse> => {
    if ((event.agentId ?? MAIN_AGENT_ID) === MAIN_AGENT_ID && isToolCallId(event.toolCallId)) {
      timeline?.approvalRequested(event.toolCallId, event.toolName);
    }
    const interaction = interactionTracker?.startInteraction({
      agentId: event.agentId,
      kind: 'permission',
    });
    try {
      const data = adaptApprovalRequest(event);
      // A badge lookup failure must never cancel the approval itself — it
      // degrades to no badge.
      let environment: string | undefined;
      try {
        environment = resolveEnvironment?.();
      } catch {
        environment = undefined;
      }
      const response = await controller.show(
        environment === undefined ? data : { ...data, environment },
      );
      onResponse?.(event, response);
      return response;
    } catch {
      const response: ApprovalResponse = {
        decision: 'cancelled',
        feedback: 'approval handler failed',
      };
      onResponse?.(event, response);
      return response;
    } finally {
      if (interaction !== undefined) interactionTracker?.endInteraction(interaction);
    }
  };
}
