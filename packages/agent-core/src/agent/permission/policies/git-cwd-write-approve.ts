import type { Agent } from '../..';
import type { ToolResourceAccess } from '../../../loop/tool-access';
import { isWithinDirectory } from '../../../tools/policies/path-access';
import {
  findGitWorkTreeMarker,
  type GitWorkTreeMarker,
} from '../../../tools/support/git-worktree';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class GitCwdWriteApprovePermissionPolicy implements PermissionPolicy {
  private readonly gitMarkerCache = new Map<string, GitWorkTreeMarker | null>();
  readonly name = 'git-cwd-write-approve';

  constructor(private readonly agent: Agent) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return undefined;
    if (this.agent.runtime.kaos.pathClass() !== 'posix') return undefined;

    const cwd = this.agent.config.cwd;
    if (cwd.length === 0) return undefined;

    const writeAccesses =
      context.execution.accesses?.filter(
        (access): access is FileAccess =>
          access.kind === 'file' &&
          access.path !== undefined &&
          (access.operation === 'write' || access.operation === 'readwrite'),
      ) ?? [];
    if (writeAccesses.length === 0) return undefined;
    if (!writeAccesses.every((access) => isWithinDirectory(access.path, cwd, 'posix'))) {
      return undefined;
    }

    const marker = await this.findGitMarker(cwd);
    if (marker === null) return undefined;

    return {
      kind: 'approve',
    };
  }

  private async findGitMarker(cwd: string): Promise<GitWorkTreeMarker | null> {
    if (this.gitMarkerCache.has(cwd)) return this.gitMarkerCache.get(cwd) ?? null;
    const marker = await findGitWorkTreeMarker(this.agent.runtime.kaos, cwd);
    this.gitMarkerCache.set(cwd, marker);
    return marker;
  }
}

type FileAccess = Extract<ToolResourceAccess, { kind: 'file' }> & { readonly path: string };
