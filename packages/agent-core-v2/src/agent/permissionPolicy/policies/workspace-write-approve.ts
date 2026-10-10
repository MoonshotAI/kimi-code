import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { isWithinWorkspace } from '#/tool/path-access';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ISessionWorkspaceContext as WorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { writeFileAccesses } from './path-utils';

export class WorkspaceWriteApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'workspace-write-approve';

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspace: WorkspaceContext,
  ) {}

  evaluate(
    context: ResolvedToolExecutionHookContext,
  ): PermissionPolicyResult | undefined {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return undefined;
    const lease = this.runtime.acquire();
    const pathClass = lease.runtime.environment.pathClass;
    lease.dispose();

    const cwd = this.workspace.workDir;
    if (cwd.length === 0) return undefined;

    const writeAccesses = writeFileAccesses(context);
    if (writeAccesses.length === 0) return undefined;
    if (
      !writeAccesses.every((access) =>
        isWithinWorkspace(
          access.path,
          { workspaceDir: cwd, additionalDirs: this.workspace.additionalDirs },
          pathClass,
        ),
      )
    ) {
      return undefined;
    }

    return { kind: 'approve' };
  }
}
