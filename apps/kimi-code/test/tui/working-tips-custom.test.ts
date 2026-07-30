import { afterEach, describe, expect, it } from 'vitest';

import { configureCustomTips } from '#/tui/constant/tips';
import { currentWorkingTip, pickRandomWorkingTip } from '#/tui/components/chrome/working-tips';

afterEach(() => {
  configureCustomTips('append', []);
});

describe('working tips with custom tips configured', () => {
  it('pickRandomWorkingTip can return a custom tip in append mode', () => {
    configureCustomTips('append', ['Accidental Virtue']);
    let seen = false;
    for (let i = 0; i < 200; i++) {
      if (pickRandomWorkingTip()?.text === 'Accidental Virtue') {
        seen = true;
        break;
      }
    }
    expect(seen).toBe(true);
  });

  it('replace mode limits picks to custom tips', () => {
    configureCustomTips('replace', ['Only Verb']);
    expect(pickRandomWorkingTip()?.text).toBe('Only Verb');
    expect(currentWorkingTip()?.text).toBe('Only Verb');
  });

  it('rebuilds the memoized rotation when the tips version changes', () => {
    configureCustomTips('replace', ['First Verb']);
    expect(pickRandomWorkingTip()?.text).toBe('First Verb');
    configureCustomTips('replace', ['Second Verb']);
    expect(pickRandomWorkingTip()?.text).toBe('Second Verb');
  });
});
