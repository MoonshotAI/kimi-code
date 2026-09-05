import { describe, expect, it } from 'vitest';

import { parseTimestamp } from '../src/util/time';

describe('parseTimestamp', () => {
  it('accepts current epoch milliseconds and legacy ISO timestamps', () => {
    expect(parseTimestamp(1_784_012_345_678)).toBe(1_784_012_345_678);
    expect(parseTimestamp('2026-07-14T01:25:45.678Z')).toBe(1_783_992_345_678);
    expect(parseTimestamp('invalid')).toBeNull();
  });
});
