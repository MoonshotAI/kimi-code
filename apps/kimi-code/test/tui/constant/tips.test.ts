import { describe, expect, it } from 'vitest';

import { getAllTips, getWorkingTips } from '#/tui/constant/tips';

describe('tips constants', () => {
  it('getAllTips() is non-empty', () => {
    expect(getAllTips().length).toBeGreaterThan(0);
  });

  it('tip texts are unique across getAllTips()', () => {
    const texts = getAllTips().map((tip) => tip.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('every tip has a non-empty text', () => {
    for (const tip of getAllTips()) {
      expect(tip.text.length).toBeGreaterThan(0);
    }
  });

  it('every tip has valid optional properties', () => {
    for (const tip of getAllTips()) {
      if (tip.priority !== undefined) {
        expect(tip.priority).toBeGreaterThan(0);
      }
      if (tip.solo !== undefined) {
        expect(typeof tip.solo).toBe('boolean');
      }
    }
  });

  it('getWorkingTips() is non-empty', () => {
    expect(getWorkingTips().length).toBeGreaterThan(0);
  });

  it('every working tip is included in getAllTips()', () => {
    const allTips = getAllTips();
    for (const workingTip of getWorkingTips()) {
      expect(allTips.some((tip) => tip.text === workingTip.text)).toBe(true);
    }
  });

  it('shared working tips match getAllTips() priority and solo values', () => {
    const allTips = getAllTips();
    for (const workingTip of getWorkingTips()) {
      const allTip = allTips.find((tip) => tip.text === workingTip.text);
      expect(allTip).toBeDefined();
      expect(allTip?.priority).toBe(workingTip.priority);
      expect(allTip?.solo).toBe(workingTip.solo);
    }
  });
});
