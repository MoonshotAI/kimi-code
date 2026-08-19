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
    private readonly onApproved: (toolCallId: string) => void,
    private readonly runEpoch: () => number,
  ) {}

  async requestApproval(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    const display = context.execution.display;
    if (display?.kind !== 'flow_gate_review') return undefined;
    const stage = this.flow.currentStage();
    if (!this.flow.run().active || stage === undefined || stage.id !== display.stage_id) {
      return undefined;
    }
    const epochAtRequest = this.flow.preparedEpochOf(context.args as object) ?? this.runEpoch();
    if (epochAtRequest !== this.runEpoch()) return undefined;
    return this.toolApproval.requestToolApproval(
      context,
      {
        kind: 'ask',
        resolveApproval: (result) => this.approvalResult(result, context, epochAtRequest),
      },
      'flow-gate-review-ask',
    );
  }

  private approvalResult(
    result: ApprovalResponse,
    context: ResolvedToolExecutionHookContext,
    epochAtRequest: number,
  ): PermissionPolicyResolution | undefined {
    if (this.runEpoch() !== epochAtRequest) {
      return {
        kind: 'result',
        result: {
          isError: true,
          output:
            'The flow run changed while this gate review was open (undo, abort, or a new run); this stale review is void. Submit FlowAdvance again against the current run.',
        },
      };
    }
    if (result.decision === 'approved') {
      this.onApproved(context.toolCall.id);
      return undefined;
    }

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
    if (feedback.length === 0 && (result.selectedLabel === undefined || result.selectedLabel.length === 0)) {
      return {
        kind: 'result',
        result: {
          isError: true,
          stopTurn: true,
          output:
            'The gate review ended without an observed user decision (transport failure or dismissal). No verdict was recorded; the flow stays at the current stage — wait for the user.',
        },
      };
    }
    const rejection = this.recordHumanRejection(context, feedback);
    if (rejection === undefined) {
      return {
        kind: 'result',
        result: {
          isError: true,
          output:
            'The gate rejection could not be recorded (the run state changed while the review was open, or the call arguments were invalid). Check the run status and submit FlowAdvance again.',
        },
      };
    }
    const stageName = `\`${rejection}\``;

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
    if (!parsed.success) return undefined;
    const stage = parsed.data.stage;
    const outcome = this.flow.advance({
      stage,
      result: 'reject',
      decidedBy: 'human',
      criteria: parsed.data.criteria,
      feedback: feedback.length > 0 ? feedback : undefined,
    });
    return outcome.recorded ? stage : undefined;
  }
}
