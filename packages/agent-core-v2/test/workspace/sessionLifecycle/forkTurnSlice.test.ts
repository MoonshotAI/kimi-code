import { describe, expect, it } from 'vitest';

import {
  resolveForkPromptIndex,
  sliceMainRecordsAtTurn,
} from '#/workspace/sessionLifecycle/internal/forkTurnSlice';
import type { WireRecord } from '#/wire/record';

function userTurnRecord(text: string, time: number, id?: string): WireRecord {
  return {
    type: 'context.append_message',
    message: {
      id,
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

describe('sliceMainRecordsAtTurn lastTurnReason', () => {
  it('derives the outcome from the last retained turn.ended record', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('first', 2),
      turnEndedRecord(0, 3, 'completed'),
      userTurnRecord('second', 4),
      turnEndedRecord(1, 5, 'cancelled'),
      userTurnRecord('third', 6),
      turnEndedRecord(2, 7, 'failed'),
    ];
    expect(sliceMainRecordsAtTurn(records, 'ses_source', 0).lastTurnReason).toBe('completed');
    expect(sliceMainRecordsAtTurn(records, 'ses_source', 1).lastTurnReason).toBe('cancelled');
    expect(sliceMainRecordsAtTurn(records, 'ses_source', 2).lastTurnReason).toBe('failed');
  });

  it('maps a blocked outcome to failed', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('blocked turn', 2),
      turnEndedRecord(0, 3, 'blocked'),
    ];
    expect(sliceMainRecordsAtTurn(records, 'ses_source', 0).lastTurnReason).toBe('failed');
  });

  it('returns undefined when the slice retains no turn.ended record', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('original prompt', 2),
      { type: 'turn.steer', turnId: 0, messageId: 'msg_steer', origin: { kind: 'user' }, time: 3 },
      userTurnRecord('steered input', 4),
      turnEndedRecord(0, 5),
    ];
    expect(sliceMainRecordsAtTurn(records, 'ses_source', 0).lastTurnReason).toBeUndefined();
    expect(sliceMainRecordsAtTurn(records, 'ses_source', 1).lastTurnReason).toBe('completed');
  });

  it('returns undefined when a later steered turn is cut before its terminal record', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('first', 2),
      turnEndedRecord(0, 3, 'completed'),
      userTurnRecord('original prompt', 4),
      { type: 'turn.steer', turnId: 1, messageId: 'msg_steer', origin: { kind: 'user' }, time: 5 },
      userTurnRecord('steered input', 6),
      turnEndedRecord(1, 7),
    ];
    expect(sliceMainRecordsAtTurn(records, 'ses_source', 0).lastTurnReason).toBe('completed');
    expect(sliceMainRecordsAtTurn(records, 'ses_source', 1).lastTurnReason).toBeUndefined();
    expect(sliceMainRecordsAtTurn(records, 'ses_source', 2).lastTurnReason).toBe('completed');
  });
});

describe('resolveForkPromptIndex', () => {
  it('resolves the visible turn index of a prompt message id', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('first', 2, 'p1'),
      turnEndedRecord(0, 3),
      userTurnRecord('second', 4, 'p2'),
      turnEndedRecord(1, 5),
      userTurnRecord('third still running', 6, 'p3'),
    ];
    expect(resolveForkPromptIndex(records, 'p1')).toEqual({ status: 'found', index: 0 });
    expect(resolveForkPromptIndex(records, 'p2')).toEqual({ status: 'found', index: 1 });
    expect(resolveForkPromptIndex(records, 'p3')).toEqual({ status: 'found', index: 2 });
  });

  it('resolves the index of a steered prompt message id', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('original prompt', 2, 'p1'),
      { type: 'turn.steer', turnId: 0, messageId: 'p2', origin: { kind: 'user' }, time: 3 },
      userTurnRecord('steered input', 4, 'p2'),
      turnEndedRecord(0, 5),
    ];
    expect(resolveForkPromptIndex(records, 'p2')).toEqual({ status: 'found', index: 1 });
  });

  it('resolves an original prompt id of a merged steer through the steer record', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('original prompt', 2, 'p1'),
      {
        type: 'turn.steer',
        turnId: 0,
        messageId: 'merged-1',
        promptIds: ['p2', 'p3'],
        origin: { kind: 'user' },
        time: 3,
      },
      userTurnRecord('merged steered input', 4, 'merged-1'),
      turnEndedRecord(0, 5),
    ];
    expect(resolveForkPromptIndex(records, 'p2')).toEqual({ status: 'found', index: 1 });
    expect(resolveForkPromptIndex(records, 'p3')).toEqual({ status: 'found', index: 1 });
  });

  it('reports ambiguous when a prompt id matches multiple visible turns', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('first', 2, 'p1'),
      turnEndedRecord(0, 3),
      userTurnRecord('second', 4, 'p1'),
      turnEndedRecord(1, 5),
    ];
    expect(resolveForkPromptIndex(records, 'p1')).toEqual({ status: 'ambiguous' });
  });

  it('reports unknown for a missing prompt id or a non-visible append', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('real prompt', 2, 'p1'),
      turnEndedRecord(0, 3),
      {
        type: 'context.append_message',
        message: {
          id: 'cron-1',
          role: 'user',
          content: [{ type: 'text', text: 'cron follow-up' }],
          origin: { kind: 'cron_job', jobId: 'job-1' },
        },
        time: 4,
      },
    ];
    expect(resolveForkPromptIndex(records, 'missing')).toEqual({ status: 'unknown' });
    expect(resolveForkPromptIndex(records, 'cron-1')).toEqual({ status: 'unknown' });
  });
});
