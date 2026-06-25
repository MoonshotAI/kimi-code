import type { ResolvedToolExecutionHookContext } from '../../../../loop';
import { isSensitiveFile } from '../../../../tools/policies/sensitive';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../permissionPolicy';
import { fileAccesses } from './path-utils';

export class SensitiveFileAccessAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'sensitive-file-access-ask';

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    const access = fileAccesses(context).find((fileAccess) => isSensitiveFile(fileAccess.path));
    return access === undefined ? undefined : { kind: 'ask' };
  }
}
