
import {
  Disposable,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { OrderedHookSlot } from '../hooks';
import { IConfigRegistry } from '#/config';
import { IReplayBuilderService } from '#/replayBuilder';
import { IWireRecord } from '#/wireRecord';
import {
  IPermissionRulesService,
  type PermissionApprovalResultRecord,
  type PermissionRule,
} from './permissionRules';
import {
  PERMISSION_SECTION,
  PermissionConfigSchema,
  permissionFromToml,
  permissionToToml,
} from './configSection';

declare module '#/wireRecord' {
  interface WireRecordMap {
    'permission.rules.add': {
      rules: readonly PermissionRule[];
    };
    'permission.record_approval_result': PermissionApprovalResultRecord;
  }

}

export class PermissionRulesService extends Disposable implements IPermissionRulesService {
  declare readonly _serviceBrand: undefined;

  private readonly localRules: PermissionRule[] = [];
  private readonly localSessionApprovalRulePatterns = new Set<string>();

  readonly hooks = {
    onChanged: new OrderedHookSlot<{ rules: readonly PermissionRule[] }>(),
    onApprovalRecorded: new OrderedHookSlot<{ record: PermissionApprovalResultRecord }>(),
  };

  constructor(
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IReplayBuilderService private readonly replayBuilder: IReplayBuilderService,
    @IConfigRegistry configRegistry: IConfigRegistry,
  ) {
    super();
    configRegistry.registerSection(PERMISSION_SECTION, PermissionConfigSchema, {
      fromToml: permissionFromToml,
      toToml: permissionToToml,
    });
    this._register(
      wireRecord.register('permission.rules.add', (record) => {
        this.applyAddRules(record.rules);
      }),
    );
    this._register(
      wireRecord.register('permission.record_approval_result', (record) => {
        const { type: _type, time: _time, ...approval } = record;
        this.applyApprovalResult(approval);
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
    this.wireRecord.append({ type: 'permission.rules.add', rules: [...rules] });
    this.applyAddRules(rules);
  }

  recordApprovalResult(record: PermissionApprovalResultRecord): void {
    this.wireRecord.append({ type: 'permission.record_approval_result', ...record });
    this.applyApprovalResult(record);
  }

  private applyAddRules(rules: readonly PermissionRule[]): void {
    if (rules.length === 0) return;
    this.localRules.push(...rules);
    this.emitRulesChanged();
  }

  private applyApprovalResult(record: PermissionApprovalResultRecord): void {
    this.replayBuilder.push({ type: 'approval_result', record });
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

registerScopedService(
  LifecycleScope.Agent,
  IPermissionRulesService,
  PermissionRulesService,
  InstantiationType.Delayed,
  'permissionRules',
);
