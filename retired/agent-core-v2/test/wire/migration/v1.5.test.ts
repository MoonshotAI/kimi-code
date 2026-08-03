/**
 * Scenario: migrate persisted goal lifecycle records from wire protocol 1.4 to 1.5.
 * Responsibilities: recover missing active wall-clock anchors without replacing persisted ones.
 * Wiring: pure migration exercised through the shared migration test surface.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/wire/migration/v1.5.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { migrateV1_4ToV1_5 } from '#/wire/migration/migration';
import { runMigration } from './utils';

describe('1.4 to 1.5 active wall-clock anchor migration', () => {
  it('backfills missing anchors from create and resume record timestamps', () => {
    expect(
      runMigration(migrateV1_4ToV1_5, [
        {
          type: 'metadata',
          protocol_version: '1.4',
          created_at: 1,
        },
        {
          type: 'goal.create',
          goalId: 'goal-1',
          objective: 'ship the feature',
          time: 10,
        },
        {
          type: 'goal.update',
          status: 'paused',
          wallClockMs: 20,
          time: 30,
        },
        {
          type: 'goal.update',
          status: 'active',
          time: 40,
        },
      ]),
    ).toMatchInlineSnapshot(`
      [wire] metadata      { "protocol_version": "<protocol-version>", "created_at": "<time>" }
      [wire] goal.create   { "goalId": "goal-1", "objective": "ship the feature", "time": "<time>", "wallClockResumedAt": 10 }
      [wire] goal.update   { "status": "paused", "wallClockMs": 20, "time": "<time>" }
      [wire] goal.update   { "status": "active", "time": "<time>", "wallClockResumedAt": 40 }
    `);
  });

  it('preserves an existing active wall-clock anchor', () => {
    expect(
      runMigration(migrateV1_4ToV1_5, [
        {
          type: 'goal.update',
          status: 'active',
          wallClockResumedAt: 35,
          time: 40,
        },
      ]),
    ).toMatchInlineSnapshot(`[wire] goal.update   { "status": "active", "wallClockResumedAt": 35, "time": "<time>" }`);
  });

  it('advances a missing anchor from a wall-clock checkpoint timestamp', () => {
    expect(
      runMigration(migrateV1_4ToV1_5, [
        {
          type: 'goal.update',
          wallClockMs: 3_000,
          time: 4_000,
        },
      ]),
    ).toMatchInlineSnapshot(
      `[wire] goal.update   { "wallClockMs": 3000, "time": "<time>", "wallClockResumedAt": 4000 }`,
    );
  });
});
