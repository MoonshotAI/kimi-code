/**
 * `permissionPolicy` test stubs — shared doubles for
 * `IAgentPermissionPolicyService`.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../permissionPolicy/stubs`).
 */

import type {
  IAgentPermissionPolicyService,
  PermissionPolicyEvaluation,
} from '#/agent/permissionPolicy/permissionPolicy';

export function stubPermissionPolicyService(
  next: () => PermissionPolicyEvaluation | undefined,
): IAgentPermissionPolicyService {
  return {
    _serviceBrand: undefined,
    evaluate: () => Promise.resolve(next()),
  };
}
