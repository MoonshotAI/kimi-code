import type { Point } from './types';

export const LOUPE_PIXELS = 17;
export const LOUPE_ZOOM = 8;
export const LOUPE_SIZE = LOUPE_PIXELS * LOUPE_ZOOM;
export const LOUPE_PANEL_SIZE = { width: LOUPE_SIZE, height: 216 } as const;

export function sourcePixel(
  point: Point,
  context: { sourceSize: { width: number; height: number }; displaySize: { width: number; height: number } },
): Point {
  return {
    x: Math.max(0, Math.min(context.sourceSize.width - 1, Math.floor(point.x * context.sourceSize.width / context.displaySize.width))),
    y: Math.max(0, Math.min(context.sourceSize.height - 1, Math.floor(point.y * context.sourceSize.height / context.displaySize.height))),
  };
}

export function loupeScale(displaySize: { width: number; height: number }): number {
  return Math.min(
    1,
    (displaySize.width - 24) / LOUPE_PANEL_SIZE.width,
    (displaySize.height - 24) / LOUPE_PANEL_SIZE.height,
  );
}

export function loupePosition(point: Point, displaySize: { width: number; height: number }): Point {
  const margin = 12;
  const gap = 16;
  const scale = loupeScale(displaySize);
  const width = LOUPE_PANEL_SIZE.width * scale;
  const height = LOUPE_PANEL_SIZE.height * scale;
  const right = point.x + gap;
  const bottom = point.y + gap;
  const x = right + width <= displaySize.width - margin
    ? right
    : point.x - gap - width;
  const y = bottom + height <= displaySize.height - margin
    ? bottom
    : point.y - gap - height;
  return {
    x: Math.max(margin, Math.min(displaySize.width - width - margin, x)),
    y: Math.max(margin, Math.min(displaySize.height - height - margin, y)),
  };
}

export function rgbHex(pixel: Uint8ClampedArray): string {
  return `#${Array.from(pixel.slice(0, 3), (channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

export function rgbaColor(pixel: Uint8ClampedArray): string {
  const alpha = Math.round((pixel[3] ?? 255) / 255 * 100) / 100;
  return `rgba(${pixel[0]},${pixel[1]},${pixel[2]},${alpha})`;
}
