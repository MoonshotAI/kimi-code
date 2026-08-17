/**
 * `permissionRules` domain — `IAgentPermissionRulesService` implementation.
 *
 * Holds the agent's permission rules and deduped session-approval patterns in
 * the `permissionRulesKey` state, mutating it only through the
 * `PermissionRulesAdd` / `PermissionRecordApprovalResult` events
 * (`dispatcher.dispatch(...)`) and reading it through `dispatcher.getState`.
 * Restore rebuilds the state silently and consumers read the getters instead.
 * Bound at Agent scope.
 */

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  IAgentPermissionRulesService,
  type PermissionApprovalResultRecord,
  type PermissionRule,
} from './permissionRules';
import {
  PermissionRecordApprovalResult,
  PermissionRulesAdd,
  permissionRulesKey,
} from './permissionRulesOps';

export class AgentPermissionRulesService implements IAgentPermissionRulesService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly agentState: IAgentStateService,
  ) {
    this.agentState.contributeState(permissionRulesKey);
  }

  get rules(): readonly PermissionRule[] {
    return [...this.agentState.get(permissionRulesKey).rules];
  }

  get sessionApprovalRulePatterns(): readonly string[] {
    return [...this.agentState.get(permissionRulesKey).sessionApprovalRulePatterns];
  }

  addRules(rules: readonly PermissionRule[]): void {
    if (rules.length === 0) return;
    void this.dispatcher.dispatch(new PermissionRulesAdd({ rules: [...rules] }));
  }

  recordApprovalResult(record: PermissionApprovalResultRecord): void {
    void this.dispatcher.dispatch(new PermissionRecordApprovalResult(record));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionRulesService,
  AgentPermissionRulesService,
  ScopeActivation.OnScopeCreated,
  'permissionRules',
);
