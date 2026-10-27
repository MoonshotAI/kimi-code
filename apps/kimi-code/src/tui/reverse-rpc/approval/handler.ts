import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from '@moonshot-ai/kimi-code-sdk';

import { adaptApprovalRequest } from './adapter';
import type { ProgramStatusInteractionTracker } from '#/tui/controllers/program-status';

import type { ApprovalController } from './controller';

export function createApprovalRequestHandler(
  controller: ApprovalController,
  onResponse?: (request: ApprovalRequest, response: ApprovalResponse) => void,
  interactionTracker?: ProgramStatusInteractionTracker,
): ApprovalHandler {
  return async (event): Promise<ApprovalResponse> => {
    const interaction = interactionTracker?.startInteraction({
      agentId: event.agentId,
      kind: 'permission',
    });
    try {
      const response = await controller.show(adaptApprovalRequest(event));
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
