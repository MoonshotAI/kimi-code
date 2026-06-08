import type { WireMigration, WireMigrationRecord } from './index';

type V1_3GoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

interface TimedWireMigrationRecord extends WireMigrationRecord {
  readonly time?: number;
}

interface V1_3GoalCreateRecord extends TimedWireMigrationRecord {
  readonly type: 'goal.create';
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
}

interface V1_3GoalUpdateRecord extends TimedWireMigrationRecord {
  readonly type: 'goal.update';
  readonly goalId: string;
  readonly status: V1_3GoalStatus;
  readonly reason?: string;
  readonly turnsUsed?: number;
  readonly tokensUsed?: number;
  readonly wallClockMs?: number;
}

interface V1_3GoalAccountUsageRecord extends TimedWireMigrationRecord {
  readonly type: 'goal.account_usage';
  readonly goalId: string;
  readonly tokensUsed?: number;
  readonly wallClockMs?: number;
}

interface V1_3GoalContinuationRecord extends TimedWireMigrationRecord {
  readonly type: 'goal.continuation';
  readonly goalId: string;
  readonly turnsUsed?: number;
}

interface V1_3GoalClearRecord extends TimedWireMigrationRecord {
  readonly type: 'goal.clear';
  readonly goalId: string;
}

export const migrateV1_3ToV1_4: WireMigration = {
  sourceVersion: '1.3',
  targetVersion: '1.4',
  migrateRecord(record: WireMigrationRecord): WireMigrationRecord {
    switch (record.type) {
      case 'goal.create':
        return migrateGoalCreate(record as V1_3GoalCreateRecord);
      case 'goal.update':
        return migrateGoalUpdate(record as V1_3GoalUpdateRecord);
      case 'goal.account_usage':
        return migrateGoalAccountUsage(record as V1_3GoalAccountUsageRecord);
      case 'goal.continuation':
        return migrateGoalContinuation(record as V1_3GoalContinuationRecord);
      case 'goal.clear':
        return migrateGoalClear(record as V1_3GoalClearRecord);
      default:
        return record;
    }
  },
};

function migrateGoalCreate(record: V1_3GoalCreateRecord): WireMigrationRecord {
  return {
    type: 'goal.create',
    goalId: record.goalId,
    objective: record.objective,
    completionCriterion: record.completionCriterion,
    time: record.time,
  };
}

function migrateGoalUpdate(record: V1_3GoalUpdateRecord): WireMigrationRecord {
  return {
    type: 'goal.update',
    status: record.status,
    reason: record.reason,
    turnsUsed: record.turnsUsed,
    tokensUsed: record.tokensUsed,
    wallClockMs: record.wallClockMs,
    time: record.time,
  };
}

function migrateGoalAccountUsage(record: V1_3GoalAccountUsageRecord): WireMigrationRecord {
  return {
    type: 'goal.update',
    tokensUsed: record.tokensUsed,
    wallClockMs: record.wallClockMs,
    time: record.time,
  };
}

function migrateGoalContinuation(record: V1_3GoalContinuationRecord): WireMigrationRecord {
  return {
    type: 'goal.update',
    turnsUsed: record.turnsUsed,
    time: record.time,
  };
}

function migrateGoalClear(record: V1_3GoalClearRecord): WireMigrationRecord {
  return {
    type: 'goal.clear',
    time: record.time,
  };
}
