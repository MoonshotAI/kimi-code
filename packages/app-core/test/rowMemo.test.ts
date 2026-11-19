import { describe, expect, it } from 'vitest';
import { createRowMemo } from '../src/client/rowMemo';

interface Row {
  id: string;
  title: string;
  busy: boolean;
  tag?: { n: number } | null;
}

function row(id: string, title = id, busy = false, tag: Row['tag'] = null): Row {
  return { id, title, busy, tag };
}

describe('createRowMemo', () => {
  it('returns the previous array when every row is shallow-equal to its predecessor', () => {
    const memo = createRowMemo<Row>((r) => r.id);
    const first = memo([row('a'), row('b')]);
    const second = memo([row('a'), row('b')]);
    expect(second).toBe(first);
  });

  it('reuses untouched row objects and rebuilds only the changed ones', () => {
    const memo = createRowMemo<Row>((r) => r.id);
    const first = memo([row('a'), row('b'), row('c')]);
    const second = memo([row('a'), row('b', 'renamed'), row('c')]);
    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]!.title).toBe('renamed');
    expect(second[2]).toBe(first[2]);
  });

  it('compares nested values by reference so a replaced object counts as a change', () => {
    const memo = createRowMemo<Row>((r) => r.id);
    const tag = { n: 1 };
    const first = memo([row('a', 'a', false, tag)]);
    expect(memo([row('a', 'a', false, tag)])).toBe(first);
    const second = memo([row('a', 'a', false, { n: 1 })]);
    expect(second).not.toBe(first);
  });

  it('keeps row identities across a reorder but yields a new array', () => {
    const memo = createRowMemo<Row>((r) => r.id);
    const first = memo([row('a'), row('b')]);
    const second = memo([row('b'), row('a')]);
    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[1]);
    expect(second[1]).toBe(first[0]);
  });

  it('handles additions and removals', () => {
    const memo = createRowMemo<Row>((r) => r.id);
    const first = memo([row('a'), row('b')]);
    const grown = memo([row('a'), row('b'), row('c')]);
    expect(grown).toHaveLength(3);
    expect(grown[0]).toBe(first[0]);
    const shrunk = memo([row('a')]);
    expect(shrunk).toEqual([row('a')]);
    expect(shrunk[0]).toBe(first[0]);
    expect(memo([])).toEqual([]);
    expect(memo([])).toBe(memo([]));
  });

  it('accepts a custom equality for composite rows', () => {
    interface Group {
      id: string;
      items: readonly string[];
    }
    const memo = createRowMemo<Group>(
      (g) => g.id,
      (a, b) => a.items.length === b.items.length && a.items.every((x, i) => x === b.items[i]),
    );
    const first = memo([{ id: 'g', items: ['x'] }]);
    expect(memo([{ id: 'g', items: ['x'] }])).toBe(first);
    expect(memo([{ id: 'g', items: ['x', 'y'] }])).not.toBe(first);
  });
});
