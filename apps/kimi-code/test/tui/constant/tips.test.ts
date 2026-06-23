import { describe, expect, it } from 'vitest';

import { ALL_TIPS } from '#/tui/constant/tips';

describe('tips constants', () => {
  it('ALL_TIPS is non-empty', () => {
    expect(ALL_TIPS.length).toBeGreaterThan(0);
  });

  it('tip texts are unique across ALL_TIPS', () => {
    const texts = ALL_TIPS.map((tip) => tip.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('every tip has a non-empty text', () => {
    for (const tip of ALL_TIPS) {
      expect(tip.text.length).toBeGreaterThan(0);
    }
  });

  it('every tip has valid optional properties', () => {
    for (const tip of ALL_TIPS) {
      if (tip.priority !== undefined) {
        expect(tip.priority).toBeGreaterThan(0);
      }
      if (tip.solo !== undefined) {
        expect(typeof tip.solo).toBe('boolean');
      }
    }
  });
});
