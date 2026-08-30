import type { ResolvedToolExecutionHookContext } from '#/actor/toolExecutor/toolHooks';
import { isWithinWorkspace } from '#/tool/path-access';
import type { IGitService as GitService } from '#/app/git/git';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { ISessionWorkspaceContext as WorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/actor/toolExecutor/permissionTypes';
import { writeFileAccesses } from './path-utils';

export class GitCwdWriteApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'git-cwd-write-approve';

  constructor(
    private readonly runtime: IAgentRuntimeService,
    private readonly workspace: WorkspaceContext,
    private readonly git: GitService,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return undefined;
    const lease = this.runtime.acquire();
    const pathClass = lease.runtime.environment.pathClass;
    lease.dispose();
    if (pathClass !== 'posix') return undefined;

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

    return (await this.git.findWorkTree(cwd)) === null
      ? undefined
      : { kind: 'approve' };
  }
}
