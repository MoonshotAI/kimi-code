import { describe, expect, it } from 'vitest';

import {
  capForkRecordsAtActiveTurn,
  lastCompletedUserVisibleTurnIndex,
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

function shellCommandRecord(
  text: string,
  time: number,
  phase: 'input' | 'output',
): WireRecord {
  return {
    type: 'context.append_message',
    message: {
      role: phase === 'input' ? 'user' : 'assistant',
      content: [{ type: 'text', text }],
      origin: { kind: 'shell_command', phase },
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

describe('capForkRecordsAtActiveTurn', () => {
  it('cuts the records before an active non-visible turn', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('done', 2, 'p1'),
      turnEndedRecord(0, 3),
      {
        type: 'turn.prompt',
        turnId: 1,
        origin: { kind: 'system_trigger', name: 'goal_continuation' },
        time: 4,
      },
      { type: 'agent.turn.started', turnId: 1, time: 5 },
    ];
    const capped = capForkRecordsAtActiveTurn(records, 0);
    expect(capped.map((record) => record.type)).toEqual([
      'metadata',
      'context.append_message',
      'turn.ended',
    ]);
  });

  it('cuts the records before an active turn that follows a shell command', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      shellCommandRecord('!ls', 2, 'input'),
      shellCommandRecord('file.ts', 3, 'output'),
      { type: 'turn.prompt', turnId: 0, origin: { kind: 'user' }, time: 4 },
      { type: 'agent.turn.started', turnId: 0, time: 5 },
    ];
    const capped = capForkRecordsAtActiveTurn(records, 0);
    expect(capped.map((record) => record.type)).toEqual([
      'metadata',
      'context.append_message',
      'context.append_message',
    ]);
  });

  it('keeps the records when no engine turn follows the last completed one', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('done', 2, 'p1'),
      turnEndedRecord(0, 3),
    ];
    expect(capForkRecordsAtActiveTurn(records, 0)).toBe(records);
  });
});

describe('lastCompletedUserVisibleTurnIndex', () => {
  it('returns undefined for empty records and for a first turn still running', () => {
    expect(lastCompletedUserVisibleTurnIndex([])).toBeUndefined();
    expect(
      lastCompletedUserVisibleTurnIndex([
        { type: 'metadata', protocol_version: '1.5', created_at: 1 },
        userTurnRecord('running turn', 2),
      ]),
    ).toBeUndefined();
  });

  it('returns the last turn start closed by a turn.ended record and ignores a running tail turn', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('first', 2),
      turnEndedRecord(0, 3),
      userTurnRecord('second', 4),
      turnEndedRecord(1, 5),
      userTurnRecord('third still running', 6),
    ];
    expect(lastCompletedUserVisibleTurnIndex(records)).toBe(1);
  });

  it.each(['cancelled', 'failed', 'blocked'] as const)(
    'treats a turn ended with reason "%s" as completed',
    (reason) => {
      const records: WireRecord[] = [
        { type: 'metadata', protocol_version: '1.5', created_at: 1 },
        userTurnRecord('interrupted', 2),
        turnEndedRecord(0, 3, reason),
      ];
      expect(lastCompletedUserVisibleTurnIndex(records)).toBe(0);
    },
  );

  it('returns the steered start index when a steer-split turn completes before a running tail', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      userTurnRecord('original prompt', 2),
      { type: 'turn.steer', turnId: 0, messageId: 'msg_steer', origin: { kind: 'user' }, time: 3 },
      userTurnRecord('steered input', 4),
      turnEndedRecord(0, 5),
      userTurnRecord('follow-up still running', 6),
    ];
    expect(lastCompletedUserVisibleTurnIndex(records)).toBe(1);
  });

  it('counts a shell command with an output append as completed', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      shellCommandRecord('!ls', 2, 'input'),
      shellCommandRecord('file.ts', 3, 'output'),
      userTurnRecord('follow-up still running', 4, 'p1'),
    ];
    expect(lastCompletedUserVisibleTurnIndex(records)).toBe(0);
  });

  it('does not count a shell command still running as completed', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      shellCommandRecord('!ls', 2, 'input'),
    ];
    expect(lastCompletedUserVisibleTurnIndex(records)).toBeUndefined();
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
    expect(lastCompletedUserVisibleTurnIndex(records)).toBe(0);
  });
});
