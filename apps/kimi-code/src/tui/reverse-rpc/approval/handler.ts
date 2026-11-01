import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from '@moonshot-ai/kimi-code-sdk';

import { adaptApprovalRequest } from './adapter';
import type { ProgramStatusInteractionTracker } from '#/tui/controllers/program-status';

import type { ApprovalController } from './controller';

export function createApprovalRequestHandler(
  controller: ApprovalController,
  onResponse?: (request: ApprovalRequest, response: ApprovalResponse) => void,
  resolveEnvironment?: () => string | undefined,
  interactionTracker?: ProgramStatusInteractionTracker,
): ApprovalHandler {
  return async (event: ApprovalRequest): Promise<ApprovalResponse> => {
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
