import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from '@moonshot-ai/kimi-code-sdk';

import { adaptApprovalRequest } from './adapter';
import type { ApprovalController } from './controller';

/**
 * The SDK routes every session approval through the one registered handler,
 * tagging the request with the initiating agent's id at runtime — a subagent
 * may be bound to a different environment than the main agent. The public
 * `ApprovalRequest` type does not declare the tag, so it is re-declared here
 * as an optional member (any `ApprovalRequest` stays assignable).
 */
type AgentApprovalRequest = ApprovalRequest & { readonly agentId?: string };

export function createApprovalRequestHandler(
  controller: ApprovalController,
  onResponse?: (request: ApprovalRequest, response: ApprovalResponse) => void,
  resolveEnvironment?: (agentId: string | undefined) => Promise<string | undefined>,
): ApprovalHandler {
  return async (event: AgentApprovalRequest): Promise<ApprovalResponse> => {
    try {
      const data = adaptApprovalRequest(event);
      // A badge lookup failure must never cancel the approval itself — it
      // degrades to no badge.
      const environment = await resolveEnvironment?.(event.agentId).catch(() => undefined);
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
