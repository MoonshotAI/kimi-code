import { describe, expect, it } from 'vitest';

import { LogCorruptError } from '#/store/commit';
import { createReplica } from '#/store/replica';

import { note, texts, type Note } from './fixtures';

describe('replica', () => {
  it('folds events, truncates on rewind, and refolds views', () => {
    const replica = createReplica<Note>();
    const view = replica.view(texts);
    const seen: (readonly string[])[] = [];
    view.subscribe((state) => seen.push(state));
    replica.apply({ seq: 0, time: 1, events: [note('a'), note('b')] });
    replica.apply({ seq: 2, time: 2, events: [note('c')] });
    replica.apply({ seq: 3, time: 3, rewind: 1 });
    replica.apply({ seq: 4, time: 4, rewind: 4, events: [note('d')] });
    expect(replica.version).toBe(5);
    expect(replica.entries().map((entry) => entry.seq)).toEqual([0, 4]);
    expect(view.getState()).toEqual(['a', 'd']);
    expect(seen).toEqual([['a', 'b'], ['a', 'b', 'c'], ['a'], ['a', 'd']]);
  });

  it('rejects a commit out of sequence', () => {
    const replica = createReplica<Note>();
    replica.apply({ seq: 0, time: 1, events: [note('a')] });
    expect(() => replica.apply({ seq: 2, time: 2, events: [note('b')] })).toThrow(LogCorruptError);
  });

  it('disposes only the view whose reducer throws', () => {
    const errors: unknown[] = [];
    const replica = createReplica<Note>((error) => errors.push(error));
    const broken = replica.view<number>({
      initial: () => 0,
      reduce: () => {
        throw new Error('boom');
      },
    });
    const healthy = replica.view(texts);
    replica.apply({ seq: 0, time: 1, events: [note('a')] });
    replica.apply({ seq: 1, time: 2, events: [note('b')] });
    expect(errors).toHaveLength(1);
    expect(broken.getState()).toBe(0);
    expect(() => broken.subscribe(() => {})).toThrow('disposed');
    expect(healthy.getState()).toEqual(['a', 'b']);
  });
});
