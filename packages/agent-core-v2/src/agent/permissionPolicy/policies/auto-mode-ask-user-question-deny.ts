import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type {
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

export class AutoModeAskUserQuestionDenyPermissionPolicyService implements PermissionPolicy {
  readonly name = 'auto-mode-ask-user-question-deny';

  evaluate(context: ResolvedToolExecutionHookContext, mode: PermissionMode): PermissionPolicyResult | undefined {
    if (mode !== 'auto') return undefined;
    if (context.toolCall.name !== 'AskUserQuestion') return undefined;
    return {
      kind: 'deny',
      message:
        'AskUserQuestion is disabled while auto permission mode is active; decide and continue.',
    };
  }
}
