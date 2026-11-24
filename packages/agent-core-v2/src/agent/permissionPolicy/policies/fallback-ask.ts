import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { bashReadOnlyFallbackReason } from './bash-read-only';

export class FallbackAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'fallback-ask';

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult {
    const reason = context.toolCall.name === 'Bash' ? bashReadOnlyFallbackReason(context) : undefined;
    return { kind: 'ask', ...(reason === undefined ? {} : { reason }) };
  }
}
