import { describe, expect, it } from 'vitest';

import {
  candidateAtPoint,
  clampRect,
  displayRect,
  drawRect,
  moveRect,
  normalizeRect,
  resizeRect,
  sourcePoint,
  sourceRect,
  subtractRects,
  toolbarPosition,
} from '../../src/renderer/screenshot/geometry';

describe('screenshot geometry', () => {
  it('normalizes reverse drags and converts display coordinates with independent axes', () => {
    expect(normalizeRect({ x: 40, y: 50 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 30, height: 30 });
    expect(sourcePoint({ x: 5.5, y: 7.5 }, 2, 1.5)).toEqual({ x: 11, y: 11 });
    expect(sourceRect({ x: 5, y: 6, width: 10, height: 12 }, 2, 1.5)).toEqual({ x: 10, y: 9, width: 20, height: 18 });
    expect(displayRect({ x: 10, y: 9, width: 20, height: 18 }, 2, 1.5)).toEqual({ x: 5, y: 6, width: 10, height: 12 });
  });

  it('keeps selections inside the source image while moving and resizing', () => {
    const bounds = { x: 0, y: 0, width: 100, height: 80 };
    expect(clampRect({ x: -20, y: 70, width: 40, height: 30 }, bounds)).toEqual({ x: 0, y: 50, width: 40, height: 30 });
    expect(moveRect({ x: 70, y: 50, width: 30, height: 30 }, { x: 20, y: 20 }, bounds)).toEqual({ x: 70, y: 50, width: 30, height: 30 });
    expect(resizeRect({ x: 20, y: 20, width: 40, height: 30 }, 'nw', { x: 100, y: 100 }, bounds)).toEqual({ x: 52, y: 42, width: 8, height: 8 });
    expect(resizeRect({ x: 70, y: 60, width: 20, height: 15 }, 'se', { x: 40, y: 40 }, bounds)).toEqual({ x: 70, y: 60, width: 30, height: 20 });
  });

  it('selects the first matching window candidate as the frontmost window', () => {
    const back = { id: 'back', x: 0, y: 0, width: 100, height: 100 };
    const front = { id: 'front', x: 20, y: 20, width: 40, height: 40 };
    expect(candidateAtPoint([front, back], { x: 30, y: 30 })?.id).toBe('front');
    expect(candidateAtPoint([front, back], { x: 90, y: 90 })?.id).toBe('back');
    expect(candidateAtPoint([front, back], { x: 120, y: 90 })).toBeNull();
  });

  it('subtracts foreground windows without overlapping or losing uncovered pixels', () => {
    const back = { x: -20, y: 0, width: 100, height: 100 };
    const front = [{ x: 0, y: 20, width: 40, height: 40 }, { x: 20, y: 40, width: 40, height: 40 }];
    const parts = subtractRects(back, front);
    for (let y = 0; y < 100; y++) {
      for (let x = -20; x < 80; x++) {
        const covered = (rect: typeof back) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
        expect(parts.filter(covered).length).toBe(front.some(covered) ? 0 : 1);
      }
    }
    expect(subtractRects(back, [{ x: -100, y: -100, width: 500, height: 500 }])).toEqual([]);
    expect(subtractRects(back, [{ x: 80, y: 0, width: 20, height: 100 }])).toEqual([back]);
  });

  it('constrains shift-drags to squares without changing direction', () => {
    const bounds = { x: 0, y: 0, width: 100, height: 80 };
    expect(drawRect({ x: 20, y: 20 }, { x: 30, y: 45 }, bounds, { aspectRatio: 1 })).toEqual({ x: 20, y: 20, width: 25, height: 25 });
    expect(drawRect({ x: 20, y: 20 }, { x: 5, y: 10 }, bounds, { aspectRatio: 1 })).toEqual({ x: 5, y: 5, width: 15, height: 15 });
    expect(drawRect({ x: 80, y: 20 }, { x: 200, y: 90 }, bounds, { aspectRatio: 1 })).toEqual({ x: 80, y: 20, width: 20, height: 20 });
    expect(drawRect({ x: 20, y: 20 }, { x: -200, y: -90 }, bounds, { aspectRatio: 1 })).toEqual({ x: 0, y: 0, width: 20, height: 20 });
  });

  it.each([false, true])('draws around the starting point and preserves the center at screen edges (square=%s)', (square) => {
    const bounds = { x: 0, y: 0, width: 100, height: 80 };
    const options = { centered: true, aspectRatio: square ? 1 : undefined };
    for (const point of [{ x: 95, y: 75 }, { x: -300, y: -100 }, { x: 500, y: -100 }]) {
      const rect = drawRect({ x: 30, y: 20 }, point, bounds, options);
      expect(rect.x + rect.width / 2).toBe(30);
      expect(rect.y + rect.height / 2).toBe(20);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(100);
      expect(rect.y + rect.height).toBeLessThanOrEqual(80);
      if (square) expect(rect.width).toBe(rect.height);
    }
  });

  it('keeps the opposite corner or edge fixed, with perpendicular growth centered for side handles', () => {
    const rect = { x: 50, y: 50, width: 100, height: 50 };
    const bounds = { x: 0, y: 0, width: 400, height: 300 };
    expect(resizeRect(rect, 'se', { x: 40, y: 5 }, bounds, { aspectRatio: 2 })).toEqual({ x: 50, y: 50, width: 140, height: 70 });
    expect(resizeRect(rect, 'nw', { x: -40, y: -5 }, bounds, { aspectRatio: 2 })).toEqual({ x: 10, y: 30, width: 140, height: 70 });
    expect(resizeRect(rect, 'e', { x: 40, y: 50 }, bounds, { aspectRatio: 2 })).toEqual({ x: 50, y: 40, width: 140, height: 70 });
    expect(resizeRect(rect, 'n', { x: 50, y: -20 }, bounds, { aspectRatio: 2 })).toEqual({ x: 30, y: 30, width: 140, height: 70 });
    expect(resizeRect(rect, 'se', { x: 20, y: 10 }, bounds, { aspectRatio: 2, centered: true })).toEqual({ x: 30, y: 40, width: 140, height: 70 });
  });

  it.each(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const)('keeps center, ratio and minimum size within bounds using the %s handle', (handle) => {
    const bounds = { x: -100, y: -80, width: 400, height: 300 };
    for (const centered of [false, true]) {
      for (const aspectRatio of [undefined, 0.5, 2]) {
        const rect = { x: -40, y: -20, width: 80, height: 80 / (aspectRatio ?? 2) };
        for (const x of [-500, -10, 0, 10, 500]) {
          for (const y of [-500, -10, 0, 10, 500]) {
            const result = resizeRect(rect, handle, { x, y }, bounds, { centered, aspectRatio });
            expect(result.width).toBeGreaterThanOrEqual(8);
            expect(result.height).toBeGreaterThanOrEqual(8);
            expect(result.x).toBeGreaterThanOrEqual(bounds.x);
            expect(result.y).toBeGreaterThanOrEqual(bounds.y);
            expect(result.x + result.width).toBeLessThanOrEqual(bounds.x + bounds.width);
            expect(result.y + result.height).toBeLessThanOrEqual(bounds.y + bounds.height);
            if (aspectRatio !== undefined) expect(result.width / result.height).toBeCloseTo(aspectRatio);
            if (centered) {
              expect(result.x + result.width / 2).toBeCloseTo(rect.x + rect.width / 2);
              expect(result.y + result.height / 2).toBeCloseTo(rect.y + rect.height / 2);
            }
          }
        }
      }
    }
  });

  it('places the toolbar below when possible and otherwise above, clamped to the viewport', () => {
    expect(toolbarPosition({ x: 250, y: 40, width: 80, height: 60 }, { width: 320, height: 240 }, { width: 180, height: 80 })).toEqual({ x: 130, y: 110 });
    expect(toolbarPosition({ x: 4, y: 180, width: 80, height: 50 }, { width: 320, height: 240 }, { width: 180, height: 80 })).toEqual({ x: 10, y: 90 });
  });

  it('right-aligns a drag selection and keeps the toolbar inside the bottom edge for full-screen selections', () => {
    const viewport = { width: 1440, height: 900 };
    const toolbar = { width: 480, height: 44 };
    expect(toolbarPosition({ x: 200, y: 200, width: 800, height: 300 }, viewport, toolbar)).toEqual({ x: 520, y: 510 });
    expect(toolbarPosition({ x: 0, y: 0, ...viewport }, viewport, toolbar)).toEqual({ x: 950, y: 846 });
  });

  it('places a clicked window toolbar near the click on the nearest available outside edge', () => {
    const selection = { x: 200, y: 200, width: 800, height: 300 };
    const viewport = { width: 1440, height: 900 };
    const toolbar = { width: 480, height: 44 };
    expect(toolbarPosition(selection, viewport, toolbar, { x: 850, y: 450 })).toEqual({ x: 610, y: 510 });
    expect(toolbarPosition(selection, viewport, toolbar, { x: 350, y: 220 })).toEqual({ x: 110, y: 146 });
  });

  it('stays near the click without covering it when a window fills the screen', () => {
    const viewport = { width: 1440, height: 900 };
    const selection = { x: 0, y: 0, ...viewport };
    expect(toolbarPosition(selection, viewport, { width: 480, height: 44 }, { x: 720, y: 450 })).toEqual({ x: 480, y: 460 });
    expect(toolbarPosition(selection, viewport, { width: 480, height: 44 }, { x: 1410, y: 875 })).toEqual({ x: 950, y: 821 });
    expect(toolbarPosition(selection, viewport, { width: 600, height: 180 }, { x: 1410, y: 875 })).toEqual({ x: 830, y: 685 });
  });

  it('keeps an expanded toolbar on its original side instead of jumping across the window', () => {
    const viewport = { width: 1440, height: 900 };
    const toolbar = { width: 480, height: 160, rowHeight: 44 };
    expect(toolbarPosition({ x: 120, y: 88, width: 877, height: 628 }, viewport, toolbar, { x: 200, y: 200 })).toEqual({ x: 10, y: 10 });
    expect(toolbarPosition({ x: 120, y: 200, width: 877, height: 610 }, viewport, toolbar, { x: 800, y: 780 })).toEqual({ x: 560, y: 730 });
  });

  it.each([
    { width: 1440, height: 900 },
    { width: 1080, height: 1920 },
    { width: 320, height: 240 },
  ])('keeps expanded toolbars within a $width by $height viewport', (viewport) => {
    for (const toolbar of [{ width: 480, height: 44 }, { width: 600, height: 200 }, { width: 600, height: 350 }]) {
      for (const anchor of [{ x: 1, y: 1 }, { x: viewport.width - 1, y: viewport.height - 1 }]) {
        const point = toolbarPosition({ x: 0, y: 0, ...viewport }, viewport, toolbar, anchor);
        expect(point.x).toBeGreaterThanOrEqual(10);
        expect(point.y).toBeGreaterThanOrEqual(10);
        expect(point.x + Math.min(toolbar.width, viewport.width - 20)).toBeLessThanOrEqual(viewport.width - 10);
        expect(point.y + Math.min(toolbar.height, viewport.height - 20)).toBeLessThanOrEqual(viewport.height - 10);
      }
    }
  });
});
