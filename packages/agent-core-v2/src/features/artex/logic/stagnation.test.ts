import { describe, expect, it } from 'vitest';

import {
  ARTEX_STAGNATION_MIN_REPEATS,
  detectStagnation,
  normalizeDirection,
} from './stagnation';

describe('normalizeDirection', () => {
  it('case-folds, collapses whitespace, and collapses digit runs to a single #', () => {
    expect(normalizeDirection('Probe   endpoint 12345 on HOST')).toBe('probe endpoint # on host');
    expect(normalizeDirection('try id 7')).toBe('try id #');
  });

  it('fingerprints two same-shaped directions with different ids/urls the same', () => {
    expect(normalizeDirection('enumerate /api/users?id=42')).toBe(
      normalizeDirection('enumerate /api/users?id=9001'),
    );
  });
});

describe('detectStagnation', () => {
  it('flags a direction repeated >=3 times with no finding since the first attempt', () => {
    const done = [
      { id: 1, summary: 'enumerate /api/users?id=1' },
      { id: 2, summary: 'enumerate /api/users?id=2' },
      { id: 3, summary: 'enumerate /api/users?id=3' },
    ];
    const result = detectStagnation(done, []);
    expect(result).toHaveLength(1);
    expect(result[0]!.repeats).toBe(3);
    expect(result[0]!.since).toBe(1);
  });

  it('does not flag when fewer than the minimum repeats', () => {
    const done = [
      { id: 1, summary: 'scan port 80' },
      { id: 2, summary: 'scan port 81' },
    ];
    expect(detectStagnation(done, [])).toHaveLength(0);
    expect(ARTEX_STAGNATION_MIN_REPEATS).toBe(3);
  });

  it('does not flag when a finding was produced after the first attempt', () => {
    const done = [
      { id: 1, summary: 'enumerate /api/users?id=1' },
      { id: 2, summary: 'enumerate /api/users?id=2' },
      { id: 3, summary: 'enumerate /api/users?id=3' },
    ];
    expect(detectStagnation(done, [{ id: 5 }])).toHaveLength(0);
  });

  it('caps the output at three stagnant directions', () => {
    const done: { id: number; summary: string }[] = [];
    let id = 1;
    for (const shape of ['alpha', 'beta', 'gamma', 'delta']) {
      for (let i = 0; i < 3; i++) done.push({ id: id++, summary: `${shape} ${String(i)}` });
    }
    expect(detectStagnation(done, [])).toHaveLength(3);
  });
});
