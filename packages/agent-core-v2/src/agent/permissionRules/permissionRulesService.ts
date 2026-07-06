/**
 * `permissionRules` domain (L3) — `IAgentPermissionRulesService` implementation.
 *
 * Holds the agent's permission rules and deduped session-approval patterns in the
 * `wire` `PermissionRulesModel`, mutating it only through the `permission.rules.add`
 * / `permission.record_approval_result` Ops (`wire.dispatch(...)`) and reading it
 * through `wire.getModel`. The `onChanged` hook is driven by a `wire.subscribe`
 * on that model (firing only when the rules slice actually changes); the
 * `onApprovalRecorded` hook is a live notification fired after the dispatch, so
 * neither re-fires on resume — `wire.replay` rebuilds the model silently and
 * consumers read the getters instead. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { OrderedHookSlot } from '#/hooks';
import { IAgentWireService, type IWireService } from '#/wire';
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

export class AgentPermissionRulesService extends Disposable implements IAgentPermissionRulesService {
  declare readonly _serviceBrand: undefined;

  readonly hooks = {
    onChanged: new OrderedHookSlot<{ rules: readonly PermissionRule[] }>(),
    onApprovalRecorded: new OrderedHookSlot<{ record: PermissionApprovalResultRecord }>(),
  };

  constructor(@IAgentWireService private readonly wire: IWireService) {
    super();
    this._register(
      wire.subscribe(PermissionRulesModel, (state, previous) => {
        if (state.rules === previous.rules) return;
        void this.hooks.onChanged.run({ rules: state.rules });
      }),
    );
  }

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
    void this.hooks.onApprovalRecorded.run({ record });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionRulesService,
  AgentPermissionRulesService,
  InstantiationType.Delayed,
  'permissionRules',
);
