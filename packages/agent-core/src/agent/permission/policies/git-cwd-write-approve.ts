import type { Agent } from '../..';
import { isWithinWorkspace } from '../../../tools/policies/path-access';
import { findGitWorkTreeMarker } from '../../../tools/support/git-worktree';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';
import { writeFileAccesses } from './file-access-ask';

export class GitCwdWriteApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'git-cwd-write-approve';

  constructor(private readonly agent: Agent) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return;
    if (this.agent.kaos.pathClass() !== 'posix') return;

    const cwd = this.agent.config.cwd;
    if (cwd.length === 0) return;

    const writeAccesses = writeFileAccesses(context);
    if (writeAccesses.length === 0) return;
    if (
      !writeAccesses.every((access) =>
        isWithinWorkspace(
          access.path,
          { workspaceDir: cwd, additionalDirs: this.agent.getAdditionalDirs() },
          'posix',
        ),
      )
    ) {
      return;
    }

    const marker = await findGitWorkTreeMarker(this.agent.kaos, cwd);
    if (marker === null) return;

    return {
      kind: 'approve',
    };
  }
}
