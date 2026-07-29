/**
 * `permissionRules` domain (L3) — `IAgentPermissionRulesService` implementation.
 *
 * Exposes the effective permission rules by composing the user-configured
 * `[permission]` rules from `config` with the agent's live rules in the `wire`
 * `PermissionRulesModel`. Mutates agent state only through the
 * `permission.rules.add` / `permission.record_approval_result` Ops
 * (`wire.dispatch(...)`); `wire.replay` rebuilds the model silently. Bound at
 * Agent scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';

import { IConfigService } from '#/app/config/config';
import { IWireService } from '#/wire/wire';
import { PERMISSION_SECTION, type PermissionConfig } from './configSection';
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

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IWireService private readonly wire: IWireService,
  ) {}

  get rules(): readonly PermissionRule[] {
    const configuredRules =
      this.config.get<PermissionConfig | undefined>(PERMISSION_SECTION)?.rules ?? [];
    return [...configuredRules, ...this.wire.getModel(PermissionRulesModel).rules];
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
  ScopeActivation.OnScopeCreated,
  'permissionRules',
);
