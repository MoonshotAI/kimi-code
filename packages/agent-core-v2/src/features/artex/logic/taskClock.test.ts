import { describe, expect, it } from 'vitest';

import { clampMaxDuration, deadlineFromTimeout } from './taskClock';

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

describe('clampMaxDuration', () => {
  it('passes the own budget through when there is no deadline', () => {
    expect(clampMaxDuration(0, 30_000, NOW_MS)).toEqual({ effMs: 30_000, clamped: false });
    expect(clampMaxDuration(-5, 0, NOW_MS)).toEqual({ effMs: 0, clamped: false });
  });

  it('keeps the own budget when it binds before the deadline', () => {
    expect(clampMaxDuration(NOW_SEC + 3600, 30_000, NOW_MS)).toEqual({
      effMs: 30_000,
      clamped: false,
    });
  });

  it('clamps to the task remaining when the deadline binds', () => {
    expect(clampMaxDuration(NOW_SEC + 10, 30_000, NOW_MS)).toEqual({ effMs: 10_000, clamped: true });
  });

  it('clamps to the remaining when the run has no own budget', () => {
    expect(clampMaxDuration(NOW_SEC + 10, 0, NOW_MS)).toEqual({ effMs: 10_000, clamped: true });
  });

  it('floors the effective duration at one second', () => {
    expect(clampMaxDuration(NOW_SEC, 30_000, NOW_MS)).toEqual({ effMs: 1_000, clamped: true });
    expect(clampMaxDuration(NOW_SEC - 100, 30_000, NOW_MS)).toEqual({ effMs: 1_000, clamped: true });
  });
});

describe('deadlineFromTimeout', () => {
  it('returns zero for a non-positive timeout', () => {
    expect(deadlineFromTimeout(0, NOW_MS)).toBe(0);
    expect(deadlineFromTimeout(-30, NOW_MS)).toBe(0);
  });

  it('adds the timeout to the current unix second', () => {
    expect(deadlineFromTimeout(600, NOW_MS)).toBe(NOW_SEC + 600);
  });
});
