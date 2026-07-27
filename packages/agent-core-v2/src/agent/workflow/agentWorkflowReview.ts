/**
 * `workflow` domain (L6) — `IAgentWorkflowReviewService` contract (Agent
 * scope).
 *
 * Owns the unconditional user review of `Workflow` tool calls: running a
 * workflow script means executing arbitrary (user-authored) JS that fans out
 * subagents, so every call goes through an explicit approval round-trip —
 * even under yolo / auto permission modes. This is a product review, not a
 * permission: it intercepts the tool with a cold `waitUntil` factory and
 * drives the shared `IAgentToolApprovalService` round-trip, mirroring the
 * plan-mode `ExitPlanMode` review. Marker interface — the service's
 * contribution is the `onBeforeExecuteTool` listener it registers on
 * construction. Bound at Agent scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const WORKFLOW_REVIEW_ORIGIN = 'workflow-run-review-ask';

export interface IAgentWorkflowReviewService {
  readonly _serviceBrand: undefined;
}

export const IAgentWorkflowReviewService: ServiceIdentifier<IAgentWorkflowReviewService> =
  createDecorator<IAgentWorkflowReviewService>('agentWorkflowReviewService');
