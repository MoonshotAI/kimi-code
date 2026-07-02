
import {
  Disposable,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { OrderedHookSlot } from '#/hooks';
import { IAgentRecordService, type AgentRecord } from '#/agent/record';
import {
  IAgentPermissionRulesService,
  type PermissionApprovalResultRecord,
  type PermissionRule,
} from './permissionRules';

declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    'permission.rules.add': {
      rules: readonly PermissionRule[];
    };
    'permission.record_approval_result': PermissionApprovalResultRecord;
  }

}

export class AgentPermissionRulesService extends Disposable implements IAgentPermissionRulesService {
  declare readonly _serviceBrand: undefined;

  private readonly localRules: PermissionRule[] = [];
  private readonly localSessionApprovalRulePatterns = new Set<string>();

  readonly hooks = {
    onChanged: new OrderedHookSlot<{ rules: readonly PermissionRule[] }>(),
    onApprovalRecorded: new OrderedHookSlot<{ record: PermissionApprovalResultRecord }>(),
  };

  constructor(
    @IAgentRecordService private readonly record: IAgentRecordService,
  ) {
    super();
    this._register(
      record.define('permission.rules.add', {
        resume: (r) => {
          this.applyAddRules(r.rules);
        },
      }),
    );
    this._register(
      record.define('permission.record_approval_result', {
        resume: (r) => {
          this.applyApprovalResult(stripRecordMeta(r));
        },
        toReplay: (r) => ({ type: 'approval_result', record: stripRecordMeta(r) }),
      }),
    );
  }

  get rules(): readonly PermissionRule[] {
    return [...this.localRules];
  }

  get sessionApprovalRulePatterns(): readonly string[] {
    return [...this.localSessionApprovalRulePatterns];
  }

  addRules(rules: readonly PermissionRule[]): void {
    if (rules.length === 0) return;
    this.record.append({ type: 'permission.rules.add', rules: [...rules] });
    this.applyAddRules(rules);
  }

  recordApprovalResult(record: PermissionApprovalResultRecord): void {
    this.record.append({ type: 'permission.record_approval_result', ...record });
    this.applyApprovalResult(record);
  }

  private applyAddRules(rules: readonly PermissionRule[]): void {
    if (rules.length === 0) return;
    this.localRules.push(...rules);
    this.emitRulesChanged();
  }

  private applyApprovalResult(record: PermissionApprovalResultRecord): void {
    if (record.result.decision === 'approved' && record.result.scope === 'session') {
      const pattern = record.sessionApprovalRule;
      if (pattern !== undefined) {
        this.localSessionApprovalRulePatterns.add(pattern);
      }
    }
    void this.hooks.onApprovalRecorded.run({ record });
  }

  private emitRulesChanged(): void {
    const rules = this.rules;
    void this.hooks.onChanged.run({ rules });
  }
}

function stripRecordMeta(
  record: AgentRecord<'permission.record_approval_result'>,
): PermissionApprovalResultRecord {
  const { type: _type, time: _time, ...approval } = record;
  return approval;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionRulesService,
  AgentPermissionRulesService,
  InstantiationType.Delayed,
  'permissionRules',
);
