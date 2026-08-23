import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
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
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
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
    void this.dispatcher.dispatch(
      new PermissionRulesAdd({ agentId: this.scopeContext.agentId, rules: [...rules] }),
    );
  }

  recordApprovalResult(record: PermissionApprovalResultRecord): void {
    void this.dispatcher.dispatch(
      new PermissionRecordApprovalResult({
        ...record,
        agentId: this.scopeContext.agentId,
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionRulesService,
  AgentPermissionRulesService,
  ScopeActivation.OnScopeCreated,
  'permissionRules',
);
