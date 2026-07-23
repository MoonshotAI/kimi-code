import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IConfigService, type IConfigService as ConfigService } from '#/app/config/config';
import { IHostEnvironment, type IHostEnvironment as HostEnvironment } from '#/os/interface/hostEnvironment';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { defaultPathKind } from '#/session/sandbox/backends/sandboxBackend';
import { resolveSandboxConfig } from '#/session/sandbox/configSection';
import { isWithinAnyRoot, matchesPathRule } from '#/session/sandbox/pathRules';
import { hostSandboxPathEnv, resolveSandboxPolicy } from '#/session/sandbox/sandboxPolicy';
import type { ResolvedSandboxPolicy, SandboxConfig } from '#/session/sandbox/sandboxTypes';
import {
  ISessionWorkspaceContext,
  type ISessionWorkspaceContext as WorkspaceContext,
} from '#/session/workspaceContext/workspaceContext';
import { isSensitiveFile, isWithinDirectory } from '#/tool/path-access';
import type { ToolFileAccess } from '#/tool/toolContract';

import { fileAccesses } from './path-utils';

export class SandboxFsDenyPermissionPolicyService implements PermissionPolicy {
  readonly name = 'sandbox-fs-deny';

  constructor(
    @IConfigService private readonly config: ConfigService,
    @ISessionWorkspaceContext private readonly workspace: WorkspaceContext,
    @IHostEnvironment private readonly env: HostEnvironment,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    const config = resolveSandboxConfig(this.config);
    if (config?.enabled !== true) return undefined;
    const accesses = fileAccesses(context);
    if (accesses.length === 0) return undefined;
    const policy = this.resolvedPolicy(config);
    for (const access of accesses) {
      const denied = this.denyAccess(access, policy);
      if (denied !== undefined) return denied;
    }
    return undefined;
  }

  private denyAccess(
    access: ToolFileAccess,
    policy: ResolvedSandboxPolicy,
  ): PermissionPolicyResult | undefined {
    if (isSensitiveFile(access.path)) {
      return {
        kind: 'deny',
        message:
          `Access to "${access.path}" is denied: it matches a sensitive-file pattern ` +
          `(env / credential / SSH key) and the sandbox upgrades sensitive files to a hard deny.`,
      };
    }
    const homeDir = this.env.homeDir;
    const reads =
      access.operation === 'read' ||
      access.operation === 'search' ||
      access.operation === 'readwrite';
    if (reads) {
      const rule = policy.denyRead.find((entry) => matchesPathRule(access.path, entry, homeDir));
      if (rule !== undefined) {
        return {
          kind: 'deny',
          message: `Read access to "${access.path}" is denied by the sandbox deny-read policy ("${rule}").`,
          reason: { matched_rule: rule },
        };
      }
      if (access.recursive === true) {
        const contained = policy.denyRead.find(
          (entry) =>
            defaultPathKind(entry) === 'dir' &&
            isWithinDirectory(entry, access.path) &&
            !isWithinDirectory(access.path, entry),
        );
        if (contained !== undefined) {
          return {
            kind: 'deny',
            message:
              `Recursive access to "${access.path}" is denied: its subtree contains the ` +
              `sandbox deny-read path "${contained}". Narrow the search or read root.`,
            reason: { matched_rule: contained },
          };
        }
      }
    }
    const writes = access.operation === 'write' || access.operation === 'readwrite';
    if (writes) {
      const rule = policy.denyWrite.find((entry) => matchesPathRule(access.path, entry, homeDir));
      if (rule !== undefined) {
        return {
          kind: 'deny',
          message: `Write access to "${access.path}" is denied by the sandbox deny-write policy ("${rule}").`,
          reason: { matched_rule: rule },
        };
      }
      if (policy.mode === 'read-only' && !isWithinAnyRoot(access.path, policy.writableRoots)) {
        return {
          kind: 'deny',
          message:
            `Write access to "${access.path}" is denied: sandbox mode is read-only ` +
            `and the path is outside the writable roots.`,
          reason: { sandbox_mode: policy.mode },
        };
      }
    }
    return undefined;
  }

  private resolvedPolicy(config: SandboxConfig): ResolvedSandboxPolicy {
    return resolveSandboxPolicy(
      config,
      { workDir: this.workspace.workDir, additionalDirs: this.workspace.additionalDirs },
      hostSandboxPathEnv(this.env.homeDir),
    );
  }
}
