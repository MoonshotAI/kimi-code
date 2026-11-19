// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { LOUPE_PIXELS } from '../../src/renderer/screenshot/loupe';
import { createLoupeTile, readLoupeTile, type LoupeTile } from '../../src/renderer/screenshot/loupe-pixels';

describe('loupe pixels', () => {
  it('allocates only a small software canvas for pixel reads', () => {
    const context = {};
    const getContext = vi.fn(() => context);
    let constructed: { width: number; height: number } | null = null;
    vi.stubGlobal('OffscreenCanvas', class {
      width: number;
      height: number;
      getContext = getContext;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        constructed = this;
      }
    });
    createLoupeTile();
    expect(constructed).toMatchObject({ width: LOUPE_PIXELS, height: LOUPE_PIXELS });
    expect(getContext).toHaveBeenCalledExactlyOnceWith('2d', { willReadFrequently: true });
    vi.unstubAllGlobals();
  });

  it('crops and reads only 17 by 17 pixels and returns the center color', () => {
    const pixels = new Uint8ClampedArray(LOUPE_PIXELS * LOUPE_PIXELS * 4);
    const center = ((LOUPE_PIXELS - 1) / 2 * LOUPE_PIXELS + (LOUPE_PIXELS - 1) / 2) * 4;
    pixels.set([23, 162, 184, 255], center);
    const context = {
      imageSmoothingEnabled: true,
      fillStyle: '',
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: pixels })),
    };
    const tile = { canvas: {}, context } as unknown as LoupeTile;
    const frame = document.createElement('img');
    const sample = readLoupeTile(frame, { x: 200, y: 200 }, tile);
    expect(context.clearRect).toHaveBeenCalledExactlyOnceWith(0, 0, 17, 17);
    expect(context.fillStyle).toBe('#171717');
    expect(context.fillRect).toHaveBeenCalledExactlyOnceWith(0, 0, 17, 17);
    expect(context.drawImage).toHaveBeenCalledExactlyOnceWith(frame, 192, 192, 17, 17, 0, 0, 17, 17);
    expect(context.getImageData).toHaveBeenCalledExactlyOnceWith(0, 0, 17, 17);
    expect(Array.from(sample)).toEqual([23, 162, 184, 255]);
  });
});
