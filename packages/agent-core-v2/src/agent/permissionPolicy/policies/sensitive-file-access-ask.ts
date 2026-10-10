import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { isSensitiveFile } from '#/tool/path-access';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { fileAccesses } from './path-utils';

export class SensitiveFileAccessAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'sensitive-file-access-ask';

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name === 'Glob') return undefined;
    if (context.toolCall.name === 'Grep') {
      const args = context.args;
      return typeof args === 'object' && args !== null &&
        'include_sensitive' in args && args.include_sensitive === true
        ? { kind: 'ask' }
        : undefined;
    }
    const access = fileAccesses(context).find((fileAccess) => isSensitiveFile(fileAccess.path));
    return access === undefined ? undefined : { kind: 'ask' };
  }
}
