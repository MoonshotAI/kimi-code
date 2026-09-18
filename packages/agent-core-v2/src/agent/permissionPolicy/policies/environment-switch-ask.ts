import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionPolicy, PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { ENVIRONMENT_SWITCH_TOOL_NAMES } from '#/features/environmentTools/environmentTools';

export class EnvironmentSwitchAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'environment-switch-ask';

  constructor(
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (this.modeService.mode === 'auto') return undefined;
    return ENVIRONMENT_SWITCH_TOOL_NAMES.includes(context.toolCall.name)
      ? { kind: 'ask' }
      : undefined;
  }
}
