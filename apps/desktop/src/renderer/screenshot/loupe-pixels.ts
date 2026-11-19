import { LOUPE_PIXELS } from './loupe';
import type { Point } from './types';

export interface LoupeTile {
  canvas: OffscreenCanvas;
  context: OffscreenCanvasRenderingContext2D;
}

export function createLoupeTile(): LoupeTile {
  const canvas = new OffscreenCanvas(LOUPE_PIXELS, LOUPE_PIXELS);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('loupe-tile-context-unavailable');
  return { canvas, context };
}

export function readLoupeTile(frame: HTMLImageElement, current: Point, tile: LoupeTile): Uint8ClampedArray {
  const radius = (LOUPE_PIXELS - 1) / 2;
  const { context } = tile;
  context.clearRect(0, 0, LOUPE_PIXELS, LOUPE_PIXELS);
  context.fillStyle = '#171717';
  context.fillRect(0, 0, LOUPE_PIXELS, LOUPE_PIXELS);
  context.drawImage(frame, current.x - radius, current.y - radius, LOUPE_PIXELS, LOUPE_PIXELS, 0, 0, LOUPE_PIXELS, LOUPE_PIXELS);
  const pixels = context.getImageData(0, 0, LOUPE_PIXELS, LOUPE_PIXELS).data;
  const center = (radius * LOUPE_PIXELS + radius) * 4;
  return pixels.slice(center, center + 4);
}
