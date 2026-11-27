import { describe, expect, it } from 'vitest';
import { classifyFaviconPixels } from './faviconInk';

type Rgba = readonly [number, number, number, number];

const SIZE = 32;
const CLEAR: Rgba = [0, 0, 0, 0];
const BLACK: Rgba = [0, 0, 0, 255];
const WHITE: Rgba = [255, 255, 255, 255];

function icon(paint: (x: number, y: number) => Rgba): Uint8ClampedArray {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) data.set(paint(x, y), (y * SIZE + x) * 4);
  }
  return data;
}

const distance = (x: number, y: number) => Math.hypot(x - 15.5, y - 15.5);
const disc = (fill: Rgba) => icon((x, y) => (distance(x, y) <= 12 ? fill : CLEAR));

describe('classifyFaviconPixels', () => {
  it('reads a black glyph on a transparent ground as dark ink', () => {
    expect(classifyFaviconPixels(disc(BLACK))).toBe('dark');
    expect(classifyFaviconPixels(disc([40, 40, 40, 255]))).toBe('dark');
  });

  it('reads a white glyph on a transparent ground as light ink', () => {
    expect(classifyFaviconPixels(disc(WHITE))).toBe('light');
    expect(classifyFaviconPixels(disc([236, 236, 236, 255]))).toBe('light');
  });

  it('ignores half-transparent antialiasing when judging the ink', () => {
    const pixels = icon((x, y) => {
      const d = distance(x, y);
      if (d <= 12) return BLACK;
      if (d <= 14) return [255, 255, 255, 100];
      return CLEAR;
    });
    expect(classifyFaviconPixels(pixels)).toBe('dark');
  });

  it('tolerates a sliver of the opposite tone', () => {
    const pixels = icon((x, y) => {
      if (y === 15 && x >= 14 && x <= 16) return WHITE;
      return distance(x, y) <= 12 ? BLACK : CLEAR;
    });
    expect(classifyFaviconPixels(pixels)).toBe('dark');
  });

  it('leaves icons that bring their own opaque ground alone', () => {
    expect(classifyFaviconPixels(icon(() => BLACK))).toBeNull();
    expect(classifyFaviconPixels(icon((x, y) => (x < 2 && y < 2 ? CLEAR : BLACK)))).toBeNull();
  });

  it('leaves dark icons with a visible light mark alone', () => {
    const pixels = icon((x, y) => {
      const d = distance(x, y);
      if (d <= 4) return WHITE;
      return d <= 12 ? BLACK : CLEAR;
    });
    expect(classifyFaviconPixels(pixels)).toBeNull();
  });

  it('leaves icons with a colored accent alone', () => {
    const pixels = icon((x, y) => {
      if (x >= 22 && y <= 9) return [229, 50, 45, 255];
      return distance(x, y) <= 12 ? BLACK : CLEAR;
    });
    expect(classifyFaviconPixels(pixels)).toBeNull();
  });

  it('treats saturated dark colors as color rather than ink', () => {
    expect(classifyFaviconPixels(disc([31, 42, 90, 255]))).toBeNull();
    expect(classifyFaviconPixels(disc([23, 114, 246, 255]))).toBeNull();
  });

  it('leaves mid-tone and empty icons alone', () => {
    expect(classifyFaviconPixels(disc([128, 128, 128, 255]))).toBeNull();
    expect(classifyFaviconPixels(icon(() => CLEAR))).toBeNull();
  });
});
