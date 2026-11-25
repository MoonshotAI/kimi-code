import { describe, expect, it } from 'vitest';
import {
  clampModelMenuMaxHeight,
  computeAnchoredFlyoutPosition,
  providerVisibleRows,
} from '../src/composer/modelMenuLayout';

describe('clampModelMenuMaxHeight', () => {
  it('caps at 480px and subtracts 16px viewport margin from the space above the anchor', () => {
    expect(clampModelMenuMaxHeight(800)).toBe(480);
    expect(clampModelMenuMaxHeight(400)).toBe(384);
  });
});

describe('providerVisibleRows', () => {
  it('shows up to 6 rows at full height', () => {
    expect(providerVisibleRows({ recentCount: 3, providerCount: 12, maxHeight: 480 })).toBe(6);
    expect(providerVisibleRows({ recentCount: 3, providerCount: 4, maxHeight: 480 })).toBe(4);
  });

  it('compresses the provider group to at least 3 rows on short viewports', () => {
    expect(providerVisibleRows({ recentCount: 3, providerCount: 12, maxHeight: 380 })).toBe(3);
    expect(providerVisibleRows({ recentCount: 3, providerCount: 2, maxHeight: 380 })).toBe(2);
  });

  it('uses scaled row and label heights when font scale changes', () => {
    expect(providerVisibleRows({ recentCount: 3, providerCount: 12, maxHeight: 480, rowHeight: 40, labelHeight: 36 })).toBe(3);
    expect(providerVisibleRows({ recentCount: 3, providerCount: 12, maxHeight: 640, rowHeight: 40, labelHeight: 36 })).toBe(6);
    expect(providerVisibleRows({ recentCount: 3, providerCount: 12, maxHeight: 380, rowHeight: 28, labelHeight: 24 })).toBe(4);
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
