import type {
  PermissionApprovalResultRecord,
  PermissionRule,
} from '../../../agent/permission';
import { createDecorator } from '../../../di';

import type { Hooks } from '../hooks';

export interface PermissionRulesChangedContext {
  readonly rules: readonly PermissionRule[];
}

export interface PermissionApprovalRecordedContext {
  readonly record: PermissionApprovalResultRecord;
}

export interface PermissionRulesServiceOptions {
  readonly initialRules?: readonly PermissionRule[];
  readonly parent?: IPermissionRulesService;
}

export interface IPermissionRulesService {
  readonly rules: readonly PermissionRule[];
  readonly sessionApprovalRulePatterns: readonly string[];

  addRules(rules: readonly PermissionRule[]): void;
  recordApprovalResult(record: PermissionApprovalResultRecord): void;

  readonly hooks: Hooks<{
    onChanged: PermissionRulesChangedContext;
    onApprovalRecorded: PermissionApprovalRecordedContext;
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IPermissionRulesService =
  createDecorator<IPermissionRulesService>('agentPermissionRulesService');
