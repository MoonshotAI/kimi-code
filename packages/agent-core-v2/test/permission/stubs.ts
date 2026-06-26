/**
 * `permission` test stubs — shared doubles for `PermissionService`
 * collaborators (`IPermissionModeService`, `IPermissionRulesService`,
 * `IPermissionPolicyService`, `IApprovalService`).
 *
 * Each factory takes a getter so a test can drive the collaborator's behavior
 * through a suite-scoped variable without rebuilding the container.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs`).
 */

import type { ApprovalResponse } from '#/approval/approval';
import { IApprovalService } from '#/approval/approval';
import { createHooks } from '#/hooks';
import type { Hooks } from '#/hooks';
import { IPermissionModeService } from '#/permissionMode';
import type { PermissionMode, PermissionPolicyEvaluation } from '#/permissionPolicy';
import { IPermissionPolicyService } from '#/permissionPolicy';
import type { PermissionRule } from '#/permissionRules';
import { IPermissionRulesService } from '#/permissionRules';

/** An `IPermissionModeService` whose `mode` reads from the supplied getter. */
export function stubPermissionModeService(
  mode: () => PermissionMode,
): IPermissionModeService {
  return {
    _serviceBrand: undefined,
    get mode() {
      return mode();
    },
    setMode: () => {},
    hooks: createHooks(['onChanged']) as Hooks<{
      onChanged: { mode: PermissionMode; previousMode: PermissionMode };
    }>,
  };
}

/** An `IPermissionRulesService` whose `rules` read from the supplied getter. */
export function stubPermissionRulesService(
  rules: () => readonly PermissionRule[],
): IPermissionRulesService {
  return {
    _serviceBrand: undefined,
    get rules() {
      return rules();
    },
    sessionApprovalRulePatterns: [],
    addRules: () => {},
    recordApprovalResult: () => {},
    hooks: createHooks(['onChanged', 'onApprovalRecorded']) as Hooks<{
      onChanged: { rules: readonly PermissionRule[] };
      onApprovalRecorded: { record: never };
    }>,
  };
}

/**
 * An `IPermissionPolicyService` whose `evaluate` delegates to the supplied
 * getter, so each test can drive the policy outcome through a suite-scoped
 * variable.
 */
export function stubPermissionPolicyService(
  next: () => PermissionPolicyEvaluation | undefined,
): IPermissionPolicyService {
  return {
    _serviceBrand: undefined,
    configure: () => {},
    evaluate: () => Promise.resolve(next()),
  };
}

/**
 * An `IApprovalService` whose `request` delegates to the supplied getter, so
 * each test can drive the approval outcome through a suite-scoped variable.
 */
export function stubApprovalService(
  next: () => ApprovalResponse,
): IApprovalService {
  return {
    _serviceBrand: undefined,
    request: () => Promise.resolve(next()),
    decide: () => {},
    listPending: () => [],
  };
}
