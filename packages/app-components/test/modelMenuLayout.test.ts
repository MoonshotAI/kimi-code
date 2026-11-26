import { describe, expect, it } from 'vitest';
import {
  clampModelMenuMaxHeight,
  computeAnchoredFlyoutPosition,
} from '../src/composer/modelMenuLayout';

describe('clampModelMenuMaxHeight', () => {
  it('caps at 480px and subtracts 16px viewport margin from the space above the anchor', () => {
    expect(clampModelMenuMaxHeight(800)).toBe(480);
    expect(clampModelMenuMaxHeight(400)).toBe(384);
  });
});

describe('computeAnchoredFlyoutPosition', () => {
  const base = {
    menuLeft: 600,
    menuTop: 300,
    menuWidth: 240,
    triggerTop: 150,
    triggerHeight: 32,
    flyoutWidth: 240,
    flyoutHeight: 185,
    firstOptionOffset: 52,
    viewportWidth: 1200,
    viewportHeight: 800,
  };

  it('opens 4px to the right with the first option aligned to the trigger row top', () => {
    expect(computeAnchoredFlyoutPosition(base)).toEqual({ side: 'right', top: 150 - 52 });
  });

  it('shifts upward to keep an 8px bottom margin while still covering the trigger row', () => {
    const pos = computeAnchoredFlyoutPosition({ ...base, menuTop: 600, triggerTop: 120 });
    expect(600 + pos.top + base.flyoutHeight).toBe(800 - 8);
    expect(pos.top).toBeLessThanOrEqual(120);
    expect(pos.top + base.flyoutHeight).toBeGreaterThanOrEqual(120 + 32);
  });

  it('flips to the left when the right side lacks space', () => {
    expect(computeAnchoredFlyoutPosition({ ...base, menuLeft: 1000 }).side).toBe('left');
  });
});
