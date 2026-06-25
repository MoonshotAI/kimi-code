import type { ResolvedToolExecutionHookContext } from '../../../../loop';
import { IProfileService } from '../../profile/profile';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../permissionPolicy';
import {
  fileAccesses,
  hasGitPathComponent,
  isGitControlPath,
} from './path-utils';
import type { PermissionPolicyRuntime } from './runtime';

export class GitControlPathAccessAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'git-control-path-access-ask';

  constructor(
    private readonly runtime: PermissionPolicyRuntime,
    @IProfileService private readonly profile: IProfileService,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    const cwd = this.cwd();
    if (cwd.length === 0) return undefined;
    const pathClass = this.runtime.pathClass();
    const accesses = fileAccesses(context);
    if (accesses.length === 0) return undefined;

    const directGitAccess = accesses.find((fileAccess) =>
      hasGitPathComponent(fileAccess.path, cwd, pathClass),
    );
    if (directGitAccess !== undefined) return { kind: 'ask' };

    const marker = await this.runtime.findGitWorkTreeMarker(cwd);
    if (marker === null) return undefined;
    const access = accesses.find((fileAccess) =>
      isGitControlPath(fileAccess.path, marker, pathClass),
    );
    return access === undefined ? undefined : { kind: 'ask' };
  }

  private cwd(): string {
    return this.runtime.options.cwd ?? this.profile.data().cwd ?? '';
  }
}
