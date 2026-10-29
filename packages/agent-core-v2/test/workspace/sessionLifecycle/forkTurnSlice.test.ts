import { describe, expect, it } from 'vitest';

import {
  sliceMainRecordsAtTurn,
  sliceRecordsBeforePendingWork,
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

describe('sliceMainRecordsAtTurn', () => {
  it('derives a fork last prompt from readable client metadata while retaining the original message', () => {
    const record: WireRecord = { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '<browser_ref>serialized</browser_ref>' }], origin: { kind: 'user', clientMetadata: [{ display_text: 'Save button · Rename it' }] } }, time: 2 };
    const slice = sliceMainRecordsAtTurn([{ type: 'metadata', protocol_version: '1.5', created_at: 1 }, record, { type: 'turn.ended', turnId: 0, reason: 'blocked', time: 3 }, userTurnRecord('next', 4)], 'example-source', 0);
    expect(slice.lastPrompt).toBe('Save button · Rename it');
    expect(slice.lastTurnReason).toBe('failed');
    expect(slice.records).toContainEqual(record);
  });

  it('keeps completed records before queued input and an active turn in a truncated fork slice', () => {
    const records: WireRecord[] = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      {
        type: 'cron.add',
        task: { id: 'aa11bb22', cron: '0 9 * * *', prompt: 'legacy', createdAt: 2 },
        time: 2,
      },
      { type: 'turn.prompt', turnId: 2, input: [{ type: 'text', text: 'hello' }], origin: { kind: 'user' }, time: 2.5 },
      userTurnRecord('hello', 3),
      { type: 'cron.cursor', id: 'aa11bb22', lastFiredAt: 4, time: 4 },
      { type: 'turn.cancel', turnId: 3, target: 'queued', time: 4.5 },
      { type: 'turn.prompt', turnId: 4, input: [{ type: 'text', text: 'retracted turn' }], origin: { kind: 'user' }, time: 4.55 },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'orphan prompt' }], origin: { kind: 'user' }, time: 4.56 },
      { type: 'turn.steer', input: [{ type: 'text', text: 'orphan steer' }], origin: { kind: 'user' }, time: 4.57 },
      { type: 'turn.prompt', turnId: 5, input: [{ type: 'text', text: 'second turn' }], origin: { kind: 'user' }, time: 4.6 },
      userTurnRecord('second turn', 5),
      { type: 'cron.add', task: { id: 'bb22cc33', cron: '0 10 * * *', prompt: 'late', createdAt: 6 }, time: 6 },
    ];

    const slice = sliceMainRecordsAtTurn(records, 'ses_source', 2);

    const types = slice.records.map((record) => record.type);
    expect(types).toContain('cron.add');
    expect(types).toContain('cron.cursor');
    expect(
      slice.records.filter((record) => record.type === 'cron.add'),
    ).toHaveLength(1);
    expect(types).toContain('metadata');
    expect(types).toContain('context.append_message');
    expect(slice.records.filter((record) => record.type === 'turn.prompt' || record.type === 'turn.steer')).toHaveLength(1);
    expect(() => sliceMainRecordsAtTurn(records, 'ses_source', 4)).toThrowError(/not found/);
    expect(sliceMainRecordsAtTurn(records, 'ses_source', 5).lastPrompt).toBe('second turn');

    const mixed: WireRecord[] = [
      userTurnRecord('legacy first', 1),
      { type: 'turn.prompt', turnId: 7, input: [{ type: 'text', text: 'persistent' }], origin: { kind: 'user' }, time: 2 },
      userTurnRecord('persistent', 3),
      { type: 'turn.ended', turnId: 7, reason: 'completed', time: 3.5 },
      userTurnRecord('legacy tail', 4),
    ];
    expect(sliceMainRecordsAtTurn(mixed, 'ses_source', 0).records).toEqual([mixed[0]]);
    expect(sliceMainRecordsAtTurn(mixed, 'ses_source', 7).records).toEqual(mixed.slice(0, 4));

    const queued = { type: 'agent.input.submitted', entry: { meta: { promptId: 'queued' } } };
    expect(sliceRecordsBeforePendingWork([...records, queued], undefined, ['queued'])).toEqual(records);
    expect(sliceRecordsBeforePendingWork([...records, { type: 'turn.prompt', turnId: 9 }], 9, [])).toEqual(records);
  });
});
