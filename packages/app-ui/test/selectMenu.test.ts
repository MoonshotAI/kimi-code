import { describe, expect, it } from 'vitest';

import { computeSelectMenuLayout, shouldBlockBehindScroll } from '../src/lib/selectMenu';

const VIEWPORT = { viewportWidth: 1024, viewportHeight: 768, gap: 4, margin: 8 };

describe('computeSelectMenuLayout', () => {
  it('opens below the trigger with the trigger width and the gap applied', () => {
    const { style, flipUp } = computeSelectMenuLayout({
      anchor: { top: 100, bottom: 138, left: 200, width: 220 },
      menuHeight: 200,
      ...VIEWPORT,
    });
    expect(flipUp).toBe(false);
    expect(style).toEqual({
      top: '142px',
      bottom: 'auto',
      left: '200px',
      width: '220px',
    });
  });

  it('flips upward when the space below cannot fit the menu but the space above can', () => {
    const { flipUp } = computeSelectMenuLayout({
      anchor: { top: 500, bottom: 538, left: 200, width: 220 },
      menuHeight: 200,
      ...VIEWPORT,
    });
    expect(flipUp).toBe(false);

    const flipped = computeSelectMenuLayout({
      anchor: { top: 600, bottom: 638, left: 200, width: 220 },
      menuHeight: 200,
      ...VIEWPORT,
    });
    expect(flipped.flipUp).toBe(true);
    expect(flipped.style).toEqual({
      top: 'auto',
      bottom: '172px',
      left: '200px',
      width: '220px',
    });
  });

  it('opens on the roomier side with a clamped max-height when neither side fits', () => {
    const up = computeSelectMenuLayout({
      anchor: { top: 600, bottom: 638, left: 200, width: 220 },
      menuHeight: 620,
      ...VIEWPORT,
    });
    expect(up.flipUp).toBe(true);
    expect(up.style.bottom).toBe('172px');
    expect(up.style.maxHeight).toBe('588px');

    const down = computeSelectMenuLayout({
      anchor: { top: 220, bottom: 258, left: 200, width: 220 },
      menuHeight: 260,
      viewportWidth: 1024,
      viewportHeight: 480,
      gap: 4,
      margin: 8,
    });
    expect(down.flipUp).toBe(false);
    expect(down.style.top).toBe('262px');
    expect(down.style.maxHeight).toBe('210px');
  });

  it('clamps the left edge into the viewport with margin clearance', () => {
    const nearRight = computeSelectMenuLayout({
      anchor: { top: 100, bottom: 138, left: 900, width: 220 },
      menuHeight: 200,
      ...VIEWPORT,
    });
    expect(nearRight.style.left).toBe('796px');

    const offLeft = computeSelectMenuLayout({
      anchor: { top: 100, bottom: 138, left: -40, width: 220 },
      menuHeight: 200,
      ...VIEWPORT,
    });
    expect(offLeft.style.left).toBe('8px');
  });

  it('pins left to the margin and clamps the width when the trigger is wider than the viewport', () => {
    const { style } = computeSelectMenuLayout({
      anchor: { top: 100, bottom: 138, left: 4, width: 2000 },
      menuHeight: 200,
      ...VIEWPORT,
    });
    expect(style.left).toBe('8px');
    expect(style.width).toBe('1008px');
  });

  it('widens the menu up to minWidth without exceeding the viewport', () => {
    const { style } = computeSelectMenuLayout({
      anchor: { top: 100, bottom: 138, left: 200, width: 220 },
      menuHeight: 200,
      minWidth: 360,
      ...VIEWPORT,
    });
    expect(style.width).toBe('360px');

    const nearRight = computeSelectMenuLayout({
      anchor: { top: 100, bottom: 138, left: 900, width: 220 },
      menuHeight: 200,
      minWidth: 360,
      ...VIEWPORT,
    });
    expect(nearRight.style.width).toBe('360px');
    expect(nearRight.style.left).toBe('656px');

    const tinyViewport = computeSelectMenuLayout({
      anchor: { top: 100, bottom: 138, left: 4, width: 220 },
      menuHeight: 200,
      viewportWidth: 300,
      viewportHeight: 768,
      gap: 4,
      margin: 8,
      minWidth: 360,
    });
    expect(tinyViewport.style.width).toBe('284px');
  });
});

describe('shouldBlockBehindScroll', () => {
  const inside = {};
  const outside = {};
  const menu = { contains: (node: unknown) => node === inside };

  it('blocks gestures whose target is outside the menu', () => {
    expect(shouldBlockBehindScroll(outside, menu)).toBe(true);
  });

  it('lets the menu’s own scroll gestures through', () => {
    expect(shouldBlockBehindScroll(inside, menu)).toBe(false);
  });

  it('blocks when the menu is gone or the target is unknown', () => {
    expect(shouldBlockBehindScroll(outside, null)).toBe(true);
    expect(shouldBlockBehindScroll(null, menu)).toBe(true);
  });
});
