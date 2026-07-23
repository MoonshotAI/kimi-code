import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IConfigService, type IConfigService as ConfigService } from '#/app/config/config';
import { IHostEnvironment, type IHostEnvironment as HostEnvironment } from '#/os/interface/hostEnvironment';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { resolveSandboxConfig } from '#/session/sandbox/configSection';
import { isWithinAnyRoot } from '#/session/sandbox/pathRules';
import { hostSandboxPathEnv, resolveSandboxPolicy } from '#/session/sandbox/sandboxPolicy';
import {
  ISessionWorkspaceContext,
  type ISessionWorkspaceContext as WorkspaceContext,
} from '#/session/workspaceContext/workspaceContext';

import { fileAccesses } from './path-utils';

export class SandboxOutsideWorkspaceAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'sandbox-outside-workspace-ask';

  constructor(
    @IConfigService private readonly config: ConfigService,
    @ISessionWorkspaceContext private readonly workspace: WorkspaceContext,
    @IHostEnvironment private readonly env: HostEnvironment,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    const config = resolveSandboxConfig(this.config);
    if (config?.enabled !== true) return undefined;
    const policy = resolveSandboxPolicy(
      config,
      { workDir: this.workspace.workDir, additionalDirs: this.workspace.additionalDirs },
      hostSandboxPathEnv(this.env.homeDir),
    );
    const access = fileAccesses(context).find(
      (fileAccess) => !isWithinAnyRoot(fileAccess.path, policy.writableRoots),
    );
    return access === undefined ? undefined : { kind: 'ask' };
  }
}
