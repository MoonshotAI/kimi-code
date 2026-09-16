import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { findGitWorkTree } from '#/app/git/workTree';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ISessionWorkspaceContext as WorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import {
  fileAccesses,
  hasGitPathComponent,
  isGitControlPath,
} from './path-utils';

export class GitControlPathAccessAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'git-control-path-access-ask';

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspace: WorkspaceContext,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    const cwd = this.workspace.workDir;
    if (cwd.length === 0) return undefined;
    const lease = this.runtime.acquire();
    try {
      const pathClass = lease.runtime.environment.pathClass;
      const fs = lease.runtime.fs;
      const accesses = fileAccesses(context);
      if (accesses.length === 0) return undefined;

      const directGitAccess = accesses.find((fileAccess) =>
        hasGitPathComponent(fileAccess.path, cwd, pathClass),
      );
      if (directGitAccess !== undefined) return { kind: 'ask' };

      if (fs === undefined) return undefined;
      const marker = await findGitWorkTree(fs, cwd);
      if (marker === null) return undefined;
      const access = accesses.find((fileAccess) =>
        isGitControlPath(fileAccess.path, marker, pathClass),
      );
      return access === undefined ? undefined : { kind: 'ask' };
    } finally {
      lease.dispose();
    }
  }
}
