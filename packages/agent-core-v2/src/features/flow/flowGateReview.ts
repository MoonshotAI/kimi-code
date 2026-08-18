import type {
  ApprovalResponse,
  PermissionPolicyResolution,
} from '#/agent/permissionPolicy/types';
import type { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';

import type { IAgentFlowService } from './flow';
import { FlowAdvanceInputSchema } from './tools/advance/advance';

export class FlowGateReview {
  constructor(
    private readonly flow: IAgentFlowService,
    private readonly toolApproval: IAgentToolApprovalService,
  ) {}

  async requestApproval(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    const display = context.execution.display;
    if (display?.kind !== 'plan_review') return undefined;
    if (display.plan.trim().length === 0) return undefined;
    return this.toolApproval.requestToolApproval(
      context,
      {
        kind: 'ask',
        resolveApproval: (result) => this.approvalResult(result, context),
      },
      'flow-gate-review-ask',
    );
  }

  private approvalResult(
    result: ApprovalResponse,
    context: ResolvedToolExecutionHookContext,
  ): PermissionPolicyResolution | undefined {
    if (result.decision === 'approved') return undefined;

    if (result.decision === 'cancelled') {
      return {
        kind: 'result',
        result: {
          isError: false,
          output: 'Gate approval dismissed. The flow stays at the current stage.',
        },
      };
    }

    const feedback = result.feedback ?? '';
    const stage = this.recordHumanRejection(context, feedback);
    const stageName = stage === undefined ? 'current' : `\`${stage}\``;

    if (feedback.length > 0) {
      return {
        kind: 'result',
        result: {
          isError: false,
          output: `The user rejected the ${stageName} stage gate. Feedback:\n\n${feedback}\n\nAddress the feedback, rework the stage, then submit FlowAdvance again.`,
        },
      };
    }

    return {
      kind: 'result',
      result: {
        isError: true,
        stopTurn: true,
        output: `The user rejected the ${stageName} stage gate. The flow stays at the current stage; wait for the user's direction.`,
      },
    };
  }

  private recordHumanRejection(
    context: ResolvedToolExecutionHookContext,
    feedback: string,
  ): string | undefined {
    const parsed = FlowAdvanceInputSchema.safeParse(context.args);
    const stage = parsed.success ? parsed.data.stage : this.flow.currentStage()?.id;
    if (stage === undefined) return undefined;
    this.flow.advance({
      stage,
      result: 'reject',
      decidedBy: 'human',
      criteria: parsed.success ? parsed.data.criteria : [],
      feedback: feedback.length > 0 ? feedback : undefined,
    });
    return stage;
  }
}
