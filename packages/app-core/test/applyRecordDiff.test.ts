import { describe, expect, it } from 'vitest';
import { applyRecordDiff } from '../src/client';

describe('applyRecordDiff', () => {
  it('assigns only entries whose reference changed, keeping target identity', () => {
    const a = [{ id: 'a' }];
    const b = [{ id: 'b' }];
    const b2 = [{ id: 'b2' }];
    const target: Record<string, unknown[]> = { s1: a, s2: b };
    const before = target;
    applyRecordDiff(target, { s1: a, s2: b2 });
    expect(target).toBe(before);
    expect(target['s1']).toBe(a); // untouched key keeps its reference
    expect(target['s2']).toBe(b2); // changed key gets the new reference
  });

  it('adds keys that only exist in next', () => {
    const target: Record<string, number> = { s1: 1 };
    applyRecordDiff(target, { s1: 1, s2: 2 });
    expect(target).toEqual({ s1: 1, s2: 2 });
  });

  it('deletes keys absent from next', () => {
    const target: Record<string, number> = { s1: 1, s2: 2 };
    applyRecordDiff(target, { s1: 1 });
    expect(target).toEqual({ s1: 1 });
    expect('s2' in target).toBe(false);
  });

  it('compares primitives by value (Object.is semantics)', () => {
    const target: Record<string, number> = { s1: 1, s2: NaN };
    applyRecordDiff(target, { s1: 1, s2: NaN });
    expect(target['s1']).toBe(1);
    expect(Number.isNaN(target['s2'])).toBe(true);
  });

  it('handles an empty next by clearing every key', () => {
    const target: Record<string, number> = { s1: 1, s2: 2 };
    applyRecordDiff(target, {});
    expect(Object.keys(target)).toHaveLength(0);
  });

  it('treats an explicitly-undefined next value as present, not absent', () => {
    const target: Record<string, number | undefined> = { s1: 1 };
    applyRecordDiff(target, { s1: undefined });
    expect('s1' in target).toBe(true);
    expect(target['s1']).toBeUndefined();
  });
});
