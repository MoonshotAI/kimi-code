import { IConfigService } from '#/app/config/config';
import { isDangerousCommandGuardEnabled } from '#/agent/permissionRules/configSection';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { isSensitiveFile } from '#/tool/path-access';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { fileAccesses } from './path-utils';

export class SensitiveFileAccessAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'sensitive-file-access-ask';

  constructor(@IConfigService private readonly config: IConfigService) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (!isDangerousCommandGuardEnabled(this.config)) return undefined;
    const access = fileAccesses(context).find((fileAccess) => isSensitiveFile(fileAccess.path));
    return access === undefined ? undefined : { kind: 'ask' };
  }
}
