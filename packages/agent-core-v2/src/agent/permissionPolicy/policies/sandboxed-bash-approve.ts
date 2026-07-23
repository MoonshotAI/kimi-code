import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IConfigService, type IConfigService as ConfigService } from '#/app/config/config';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { resolveSandboxConfig } from '#/session/sandbox/configSection';

export class SandboxedBashApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'sandboxed-bash-approve';

  constructor(@IConfigService private readonly config: ConfigService) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    const sandbox = resolveSandboxConfig(this.config);
    if (sandbox?.enabled !== true) return undefined;
    if (sandbox.autoAllowSandboxedBash === false) return undefined;
    return context.execution.sandbox?.kind === 'sandboxed' ? { kind: 'approve' } : undefined;
  }
}
