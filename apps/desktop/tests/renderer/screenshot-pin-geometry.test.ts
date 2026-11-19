import { describe, expect, it } from 'vitest';
import { pinResizeEdgeAt, resizePinnedBounds } from '../../src/shared/screenshot-pin';

describe('pin resize geometry', () => {
  const bounds = { x: 100, y: 200, width: 400, height: 200 };
  const area = { x: 0, y: 0, width: 1440, height: 900 };

  it('distinguishes image dragging from all eight resize edges', () => {
    expect(pinResizeEdgeAt(200, 100, 400, 200)).toBeNull();
    for (const [x, y, edge] of [[0, 0, 'top-left'], [399, 0, 'top-right'], [0, 199, 'bottom-left'], [399, 199, 'bottom-right'], [200, 0, 'top'], [200, 199, 'bottom'], [0, 100, 'left'], [399, 100, 'right']] as const) {
      expect(pinResizeEdgeAt(x, y, 400, 200)).toBe(edge);
    }
  });

  it('preserves the opposite corner and image ratio', () => {
    expect(resizePinnedBounds(bounds, area, 'top-left', 80, 40)).toEqual({ x: 180, y: 240, width: 320, height: 160 });
    expect(resizePinnedBounds(bounds, area, 'bottom-right', 80, 40)).toEqual({ x: 100, y: 200, width: 480, height: 240 });
    expect(resizePinnedBounds(bounds, area, 'right', 80, 0)).toEqual({ x: 100, y: 200, width: 480, height: 240 });
  });

  it('keeps extreme drags within a display with negative coordinates', () => {
    const negative = { x: -1440, y: -900, width: 1440, height: 900 };
    const moved = { ...bounds, x: -800, y: -600 };
    expect(resizePinnedBounds(moved, negative, 'top-left', -10000, -10000)).toEqual({ x: -1440, y: -900, width: 1440, height: 720 });
    const minimum = resizePinnedBounds(moved, negative, 'bottom-right', -10000, -10000);
    expect(minimum.width).toBe(120);
    expect(minimum.height).toBe(60);
  });
});
