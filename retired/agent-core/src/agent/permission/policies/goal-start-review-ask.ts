import type { Agent } from '../..';
import type {
  ApprovalResponse,
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
} from '../types';

/**
 * Starting a goal turns the agent loose on autonomous, multi-turn work, so a
 * model-issued `CreateGoal` is confirmed with the same menu the `/goal` command
 * shows: choose the permission mode to run the goal under, or decline. The
 * chosen mode is applied before the goal is created so the run proceeds under
 * it. `auto` mode auto-approves the goal upstream and never reaches here.
 */
export class GoalStartReviewAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'goal-start-review-ask';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'CreateGoal') return;
    if (this.agent.permission.mode === 'auto') return;
    if (context.execution.display?.kind !== 'goal_start') return;
    return {
      kind: 'ask',
      resolveApproval: (result) => this.resolveGoalStart(result),
    };
  }

  private resolveGoalStart(result: ApprovalResponse): undefined {
    // Declining ("Do not start") or any non-approval creates no goal; the tool
    // call is then blocked with the standard rejection message.
    if (result.decision !== 'approved') return undefined;
    // The selected option names the permission mode to run the goal under.
    const mode = toPermissionMode(result.selectedLabel);
    if (mode !== undefined && mode !== this.agent.permission.mode) {
      this.agent.permission.setMode(mode);
    }
    // Approved: let CreateGoal execute and create the goal under the chosen mode.
    return undefined;
  }
}

function toPermissionMode(label: string | undefined): PermissionMode | undefined {
  if (label === 'auto' || label === 'yolo' || label === 'manual') return label;
  return undefined;
}
