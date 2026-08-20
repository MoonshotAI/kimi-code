import { describe, expect, it } from 'vitest';

import { sliceMainRecordsAtTurn } from '#/workspace/sessionLifecycle/internal/forkTurnSlice';
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
