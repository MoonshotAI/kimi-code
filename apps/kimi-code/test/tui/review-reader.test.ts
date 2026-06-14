import { describe, expect, it } from 'vitest';

import { clampIndex } from '#/tui/components/dialogs/review-reader';

describe('clampIndex', () => {
  it('keeps the index within [0, length)', () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-2, 3)).toBe(0);
    expect(clampIndex(1, 3)).toBe(1);
  });

  it('returns 0 for an empty list', () => {
    expect(clampIndex(4, 0)).toBe(0);
  });
});
