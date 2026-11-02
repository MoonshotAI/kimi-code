import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { isWithinWorkspace } from '#/tool/path-access';
import { findGitWorkTree } from '#/app/git/workTree';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { acquireEnvironmentLease } from './environment-lease';
import { writeFileAccesses } from './path-utils';

export class GitCwdWriteApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'git-cwd-write-approve';

  constructor(
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return undefined;
    const environment = context.environment ?? this.environment;
    const lease = acquireEnvironmentLease(environment);
    if (lease === undefined) return undefined;
    try {
      const pathClass = lease.environment.host?.pathClass;
      if (pathClass !== 'posix') return undefined;
      const fs = lease.environment.fs;
      if (fs === undefined) return undefined;

      const roots = environment.workspaceRoots();
      const cwd = roots.workDir;
      if (cwd.length === 0) return undefined;

      const writeAccesses = writeFileAccesses(context);
      if (writeAccesses.length === 0) return undefined;
      if (
        !writeAccesses.every((access) =>
          isWithinWorkspace(
            access.path,
            { workspaceDir: cwd, additionalDirs: roots.additionalDirs ?? [] },
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
