/**
 * `workflow` domain (L6) — `IAgentWorkflowReviewService` implementation.
 *
 * Registers the Workflow product review as an `onBeforeExecuteTool` veto
 * listener: while the `dynamic-workflows` experiment is enabled, every
 * `Workflow` tool call defers to a cold `waitUntil` factory that drives the
 * `toolApproval` round-trip (origin `workflow-run-review-ask`). The factory
 * runs only once no other listener vetoed or allowed the call, and it asks
 * unconditionally — no permission mode exempts a workflow script from user
 * review. The default ask continuations apply: an approved call proceeds,
 * anything else vetoes with the shared rejection message. Bound at Agent
 * scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { BeforeToolExecuteEvent } from '#/agent/toolExecutor/toolHooks';
import { IFlagService } from '#/app/flag/flag';
import { DYNAMIC_WORKFLOWS_FLAG_ID } from '#/app/workflow/flag';
import { WORKFLOW_TOOL_NAME } from '#/app/workflow/workflow.types';

import { IAgentWorkflowReviewService, WORKFLOW_REVIEW_ORIGIN } from './agentWorkflowReview';

export class AgentWorkflowReviewService extends Disposable implements IAgentWorkflowReviewService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IFlagService private readonly flags: IFlagService,
  ) {
    super();
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        this.reviewToolExecution(event);
      }),
    );
  }

  private reviewToolExecution(event: BeforeToolExecuteEvent): void {
    if (event.toolCall.name !== WORKFLOW_TOOL_NAME) return;
    if (!this.flags.enabled(DYNAMIC_WORKFLOWS_FLAG_ID)) return;
    event.waitUntil(() =>
      this.toolApproval.requestToolApproval(
        event,
        { kind: 'ask', reason: { workflow: true } },
        WORKFLOW_REVIEW_ORIGIN,
      ),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentWorkflowReviewService,
  AgentWorkflowReviewService,
  ScopeActivation.OnScopeCreated,
  'workflow',
);
