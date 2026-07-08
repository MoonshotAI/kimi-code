/**
 * `permissionRules` test stubs — shared doubles for
 * `IAgentPermissionRulesService`.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../permissionRules/stubs`).
 */

import type {
  IAgentPermissionRulesService,
  PermissionRule,
} from '#/agent/permissionRules/permissionRules';

export function stubPermissionRulesService(
  rules: () => readonly PermissionRule[],
): IAgentPermissionRulesService {
  return {
    _serviceBrand: undefined,
    get rules() {
      return rules();
    },
    sessionApprovalRulePatterns: [],
    addRules: () => {},
    recordApprovalResult: () => {},
  };
}
