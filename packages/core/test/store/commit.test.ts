import { describe, expect, it } from 'vitest';

import { decodeCommit, encodeCommit, LogCorruptError, parseLog } from '#/store/commit';

import { note } from './fixtures';

describe('codec', () => {
  it('round-trips commits and drops a torn tail', () => {
    const first = encodeCommit({ seq: 0, time: 1, events: [note('a')] });
    const second = encodeCommit({ seq: 1, time: 2, rewind: 0 });
    expect(parseLog(`${first}\n${second}\n{"seq":2,"ti`)).toEqual([
      { seq: 0, time: 1, events: [note('a')] },
      { seq: 1, time: 2, rewind: 0 },
    ]);
  });

  it('rejects values that do not survive JSON', () => {
    for (const value of [new Date(0), Number.NaN, new Map(), [undefined]]) {
      expect(() => encodeCommit({ seq: 0, time: 1, events: [{ type: 'x', value }] })).toThrow(TypeError);
    }
    expect(() => encodeCommit({ seq: 0, time: 1 })).toThrow(TypeError);
    expect(() => encodeCommit({ seq: 1, time: 1, rewind: 2 })).toThrow(TypeError);
  });

  it('rejects malformed lines and unknown fields', () => {
    for (const line of [
      'not json',
      '[]',
      '{"seq":0,"time":1}',
      '{"seq":-1,"time":1,"rewind":0}',
      '{"seq":0,"time":1,"events":[{"text":"a"}]}',
      '{"seq":0,"time":1,"rewind":0,"fork":"a"}',
    ]) {
      expect(() => decodeCommit(line)).toThrow(LogCorruptError);
    }
  });
});
