import { describe, expect, it } from 'vitest';

import { migrateV1_3ToV1_4 } from '../../../../src/agent/records/migration/v1.4';
import { runMigration } from './utils';

describe('1.3 to 1.4', () => {
  it('rewrites legacy goal audit records to replayable goal state records', () => {
    expect(
      runMigration(migrateV1_3ToV1_4, [
        {
          type: 'metadata',
          protocol_version: '1.3',
          created_at: 1,
        },
        {
          type: 'goal.create',
          goalId: 'goal-1',
          objective: 'ship the feature',
          completionCriterion: 'tests pass',
          status: 'active',
          actor: 'user',
          budgetLimits: {},
          time: 10,
        },
        {
          type: 'goal.account_usage',
          goalId: 'goal-1',
          usageKind: 'token',
          delta: 5,
          agentId: 'main',
          agentType: 'main',
          source: 'session',
          tokensUsed: 5,
          wallClockMs: 0,
          time: 20,
        },
        {
          type: 'goal.continuation',
          goalId: 'goal-1',
          turnsUsed: 1,
          time: 30,
        },
        {
          type: 'goal.update',
          goalId: 'goal-1',
          status: 'paused',
          actor: 'runtime',
          reason: 'Paused after session resume',
          turnsUsed: 1,
          tokensUsed: 5,
          wallClockMs: 0,
          time: 40,
        },
        {
          type: 'goal.clear',
          goalId: 'goal-1',
          actor: 'user',
          reason: 'Cancelled',
          time: 50,
        },
        {
          type: 'forked',
          time: 60,
        },
      ]),
    ).toMatchInlineSnapshot(`
      [wire] metadata      { "protocol_version": "<protocol-version>", "created_at": "<time>" }
      [wire] goal.create   { "goalId": "goal-1", "objective": "ship the feature", "completionCriterion": "tests pass", "time": "<time>" }
      [wire] goal.update   { "tokensUsed": 5, "wallClockMs": 0, "time": "<time>" }
      [wire] goal.update   { "turnsUsed": 1, "time": "<time>" }
      [wire] goal.update   { "status": "paused", "reason": "Paused after session resume", "turnsUsed": 1, "tokensUsed": 5, "wallClockMs": 0, "actor": "runtime", "time": "<time>" }
      [wire] goal.clear    { "time": "<time>" }
      [wire] forked        { "time": "<time>" }
    `);
  });
});
