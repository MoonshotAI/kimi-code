import type { WireMigration, WireMigrationRecord } from './migration';

interface V1_1ApprovalResult {
  readonly decision: 'approved' | 'rejected' | 'cancelled';
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

interface V1_1ApprovalResultRecord extends WireMigrationRecord {
  readonly type: 'permission.record_approval_result';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly result: V1_1ApprovalResult;
}

const LEGACY_SESSION_APPROVAL_ACTION_TO_PATTERN: Readonly<Record<string, string>> = {
  'run command': 'Bash',
  'stop background task': 'TaskStop',
  'edit file': 'Write',
  'edit file outside of working directory': 'Write',
  'write file': 'Write',
};

const LEGACY_SESSION_APPROVAL_UNRESTORABLE_ACTIONS = new Set<string>([
  'run command in plan mode',
  'run background command',
]);

export const migrateV1_1ToV1_2: WireMigration = {
  sourceVersion: '1.1',
  targetVersion: '1.2',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    if (record.type !== 'permission.record_approval_result') return record;
    const approvalRecord = record as V1_1ApprovalResultRecord;
    if (
      approvalRecord.result.decision !== 'approved' ||
      approvalRecord.result.scope !== 'session'
    ) {
      return record;
    }
    if (approvalRecord.sessionApprovalRule !== undefined) return record;

    const pattern = LEGACY_SESSION_APPROVAL_UNRESTORABLE_ACTIONS.has(approvalRecord.action)
      ? undefined
      : LEGACY_SESSION_APPROVAL_ACTION_TO_PATTERN[approvalRecord.action] ??
        approvalRecord.toolName;
    if (pattern === undefined) return record;

    return {
      ...record,
      sessionApprovalRule: pattern,
    };
  },
};
