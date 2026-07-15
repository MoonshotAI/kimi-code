/**
 * `permissionRules` domain (L3) — `IAgentPermissionRulesService` implementation.
 *
 * Holds the agent's permission rules and deduped session-approval patterns in the
 * `wire` `PermissionRulesModel`, mutating it only through the `permission.rules.add`
 * / `permission.record_approval_result` Ops (`wire.dispatch(...)`) and reading it
 * through `wire.getModel`. `wire.replay` rebuilds the model silently and
 * consumers read the getters instead. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IWireService } from '#/wire/wire';
import {
  IAgentPermissionRulesService,
  type PermissionApprovalResultRecord,
  type PermissionRule,
} from './permissionRules';
import {
  addPermissionRules,
  PermissionRulesModel,
  recordApprovalResult as recordApprovalResultOp,
} from './permissionRulesOps';

export class AgentPermissionRulesService implements IAgentPermissionRulesService {
  declare readonly _serviceBrand: undefined;

  constructor(@IWireService private readonly wire: IWireService) {}

  get rules(): readonly PermissionRule[] {
    return [...this.wire.getModel(PermissionRulesModel).rules];
  }

  get sessionApprovalRulePatterns(): readonly string[] {
    return [...this.wire.getModel(PermissionRulesModel).sessionApprovalRulePatterns];
  }

  addRules(rules: readonly PermissionRule[]): void {
    if (rules.length === 0) return;
    this.wire.dispatch(addPermissionRules({ rules: [...rules] }));
  }

  recordApprovalResult(record: PermissionApprovalResultRecord): void {
    this.wire.dispatch(recordApprovalResultOp(record));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionRulesService,
  AgentPermissionRulesService,
  InstantiationType.Eager,
  'permissionRules',
);
