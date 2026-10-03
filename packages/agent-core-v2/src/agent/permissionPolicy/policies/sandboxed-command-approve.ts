

import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ISandboxService } from '#/os/sandbox/sandboxService';
import { ISandboxProfileResolver } from '#/os/sandbox/sandboxProfileResolver';
import { resolveSandboxConfig } from '#/os/sandbox/configSection';
import { SANDBOX_FLAG_ID } from '#/os/sandbox/flag';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

export class SandboxedCommandApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'sandboxed-command-approve';

  constructor(
    @ISandboxService private readonly sandbox: ISandboxService,
    @ISandboxProfileResolver private readonly resolver: ISandboxProfileResolver,
    @IFlagService private readonly flags: IFlagService,
    @IConfigService private readonly config: IConfigService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (!this.flags.enabled(SANDBOX_FLAG_ID)) return undefined;
    if (!this.sandbox.supported) return undefined;
    if (resolveSandboxConfig(this.config)?.autoApproveSandboxed !== true) return undefined;
    if (context.toolCall.name !== 'Bash') return undefined;
    const command = bashCommandText(context.args);
    if (command === undefined) return undefined;
    const cwd = this.ctx.cwd;
    const profile = this.resolver.resolve({
      cwd,
      workspaceRoots: [this.workspaceCtx.workDir, ...this.workspaceCtx.additionalDirs],
      command,
    });
    if (profile === undefined || profile.mode === 'danger-full-access') return undefined;
    return { kind: 'approve', reason: { sandboxed: true, sandbox_mode: profile.mode } };
  }
}

function bashCommandText(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as { readonly command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}
