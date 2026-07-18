import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type {
  PermissionPolicy,
  PermissionMode,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

export class GoalStartReviewAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'goal-start-review-ask';

  constructor(
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'CreateGoal') return undefined;
    if (this.modeService.mode === 'auto') return undefined;
    if (context.execution.display?.kind !== 'goal_start') return undefined;
    return {
      kind: 'ask',
      resolveApproval: (result) => {
        if (result.decision !== 'approved') return undefined;
        const mode = toPermissionMode(result.selectedLabel);
        if (mode !== undefined && mode !== this.modeService.mode) {
          this.modeService.setMode(mode);
        }
        return undefined;
      },
    };
  }
}

function toPermissionMode(label: string | undefined): PermissionMode | undefined {
  if (label === 'auto' || label === 'yolo' || label === 'manual') return label;
  return undefined;
}
