import { describe, expect, it } from 'vitest';

import {
  countCompletedUserVisibleTurns,
  sliceMainRecordsAtTurn,
} from '#/workspace/sessionLifecycle/internal/forkTurnSlice';
import type { WireRecord } from '#/wire/record';

function userTurnRecord(text: string, time: number): WireRecord {
  return {
    type: 'context.append_message',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      origin: { kind: 'user' },
    },
    time,
  };
}

function turnEndedRecord(
  turnId: number,
  time: number,
  reason: 'completed' | 'cancelled' | 'failed' | 'blocked' = 'completed',
): WireRecord {
  return { type: 'turn.ended', agentId: 'main', turnId, reason, time };
}

describe('sliceMainRecordsAtTurn', () => {
  it('derives a fork last prompt from readable client metadata while retaining the original message', () => {
    const record: WireRecord = { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '<browser_ref>serialized</browser_ref>' }], origin: { kind: 'user', clientMetadata: [{ display_text: 'Save button · Rename it' }] } }, time: 2 };
    const slice = sliceMainRecordsAtTurn([{ type: 'metadata', protocol_version: '1.5', created_at: 1 }, record, userTurnRecord('next', 3)], 'example-source', 0);
    expect(slice.lastPrompt).toBe('Save button · Rename it');
    expect(slice.records).toContainEqual(record);
  });

  it('keeps cron records that fall inside a truncated fork slice', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      {
        type: 'cron.add',
        task: { id: 'aa11bb22', cron: '0 9 * * *', prompt: 'legacy', createdAt: 2 },
        time: 2,
      },
      userTurnRecord('hello', 3),
      { type: 'cron.cursor', id: 'aa11bb22', lastFiredAt: 4, time: 4 },
      userTurnRecord('second turn', 5),
      { type: 'cron.add', task: { id: 'bb22cc33', cron: '0 10 * * *', prompt: 'late', createdAt: 6 }, time: 6 },
    ];

    const slice = sliceMainRecordsAtTurn(records, 'ses_source', 0);

    const types = slice.records.map((record) => record.type);
    expect(types).toContain('cron.add');
    expect(types).toContain('cron.cursor');
    expect(
      slice.records.filter((record) => record.type === 'cron.add'),
    ).toHaveLength(1);
    expect(types).toContain('metadata');
    expect(types).toContain('context.append_message');
  });
});

describe('countCompletedUserVisibleTurns', () => {
  it('returns zero for empty records and for a first turn still running', () => {
    expect(countCompletedUserVisibleTurns([])).toBe(0);
    expect(
      countCompletedUserVisibleTurns([
        { type: 'metadata', protocol_version: '1.5', created_at: 1 },
        userTurnRecord('running turn', 2),
      ]),
    ).toBe(0);
  });

  it('counts turns closed by a turn.ended record and ignores a running tail turn', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('first', 2),
      turnEndedRecord(0, 3),
      userTurnRecord('second', 4),
      turnEndedRecord(1, 5),
      userTurnRecord('third still running', 6),
    ];
    expect(countCompletedUserVisibleTurns(records)).toBe(2);
  });

  it.each(['cancelled', 'failed', 'blocked'] as const)(
    'counts a turn ended with reason "%s" as completed',
    (reason) => {
      const records: WireRecord[] = [
        { type: 'metadata', protocol_version: '1.5', created_at: 1 },
        userTurnRecord('interrupted', 2),
        turnEndedRecord(0, 3, reason),
      ];
      expect(countCompletedUserVisibleTurns(records)).toBe(1);
    },
  );

  it('treats a steer-split pair sharing one turn.ended as a single completable turn', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('original prompt', 2),
      { type: 'turn.steer', turnId: 0, messageId: 'msg_steer', origin: { kind: 'user' }, time: 3 },
      userTurnRecord('steered input', 4),
      turnEndedRecord(0, 5),
    ];
    expect(countCompletedUserVisibleTurns(records)).toBe(1);
  });

  it('does not treat system-triggered appends as turn starts', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('real prompt', 2),
      turnEndedRecord(0, 3),
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'system follow-up' }],
          origin: { kind: 'system_trigger', name: 'goal_continuation' },
        },
        time: 4,
      },
      turnEndedRecord(1, 5),
    ];
    expect(countCompletedUserVisibleTurns(records)).toBe(1);
  });
});
