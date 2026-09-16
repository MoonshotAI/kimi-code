import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { isWithinWorkspace } from '#/tool/path-access';
import { findGitWorkTree } from '#/app/git/workTree';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ISessionWorkspaceContext as WorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { writeFileAccesses } from './path-utils';

export class GitCwdWriteApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'git-cwd-write-approve';

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspace: WorkspaceContext,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return undefined;
    const lease = this.runtime.acquire();
    try {
      const pathClass = lease.runtime.environment.pathClass;
      if (pathClass !== 'posix') return undefined;
      const fs = lease.runtime.fs;
      if (fs === undefined) return undefined;

      const cwd = this.workspace.workDir;
      if (cwd.length === 0) return undefined;

      const writeAccesses = writeFileAccesses(context);
      if (writeAccesses.length === 0) return undefined;
      if (
        !writeAccesses.every((access) =>
          isWithinWorkspace(
            access.path,
            { workspaceDir: cwd, additionalDirs: this.workspace.additionalDirs },
            'posix',
          ),
        )
      ) {
        return undefined;
      }

      return (await findGitWorkTree(fs, cwd)) === null
        ? undefined
        : { kind: 'approve' };
    } finally {
      lease.dispose();
    }
  }
}
