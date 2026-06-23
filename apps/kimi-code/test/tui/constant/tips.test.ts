import { describe, expect, it } from 'vitest';

import { ALL_TIPS, WORKING_TIPS } from '#/tui/constant/tips';

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

  it('WORKING_TIPS is non-empty', () => {
    expect(WORKING_TIPS.length).toBeGreaterThan(0);
  });

  it('every working tip is included in ALL_TIPS', () => {
    for (const workingTip of WORKING_TIPS) {
      expect(ALL_TIPS.some((tip) => tip.text === workingTip.text)).toBe(true);
    }
  });

  it('shared working tips match ALL_TIPS priority and solo values', () => {
    for (const workingTip of WORKING_TIPS) {
      const allTip = ALL_TIPS.find((tip) => tip.text === workingTip.text);
      expect(allTip).toBeDefined();
      expect(allTip?.priority).toBe(workingTip.priority);
      expect(allTip?.solo).toBe(workingTip.solo);
    }
  });
});
