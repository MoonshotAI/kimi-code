import type { ResolvedToolExecutionHookContext } from '../../../../loop';
import { isWithinWorkspace } from '../../../../tools/policies/path-access';
import { IProfileService } from '../../profile/profile';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../permissionPolicy';
import { writeFileAccesses } from './path-utils';
import type { PermissionPolicyRuntime } from './runtime';

export class GitCwdWriteApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'git-cwd-write-approve';

  constructor(
    private readonly runtime: PermissionPolicyRuntime,
    @IProfileService private readonly profile: IProfileService,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return undefined;
    if (this.runtime.pathClass() !== 'posix') return undefined;

    const cwd = this.cwd();
    if (cwd.length === 0) return undefined;

    const writeAccesses = writeFileAccesses(context);
    if (writeAccesses.length === 0) return undefined;
    const additionalDirs = this.runtime.options.additionalDirs ?? [];
    if (
      !writeAccesses.every((access) =>
        isWithinWorkspace(access.path, { workspaceDir: cwd, additionalDirs }, 'posix'),
      )
    ) {
      return undefined;
    }

    return (await this.runtime.findGitWorkTreeMarker(cwd)) === null
      ? undefined
      : { kind: 'approve' };
  }

  private cwd(): string {
    return this.runtime.options.cwd ?? this.profile.data().cwd ?? '';
  }
}
