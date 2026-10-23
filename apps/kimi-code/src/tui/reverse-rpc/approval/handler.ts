import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from '@moonshot-ai/kimi-code-sdk';

import { adaptApprovalRequest } from './adapter';
import type { ApprovalController } from './controller';

export function createApprovalRequestHandler(
  controller: ApprovalController,
  onResponse?: (request: ApprovalRequest, response: ApprovalResponse) => void,
  resolveEnvironment?: () => string | undefined,
): ApprovalHandler {
  return async (event: ApprovalRequest): Promise<ApprovalResponse> => {
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
    }
  };
}
