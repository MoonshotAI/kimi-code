import type { Point, Rect, ScreenshotWindowCandidate } from './types';

export const MIN_SELECTION_SIZE = 8;

export function normalizeRect(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function clampRect(rect: Rect, bounds: Rect): Rect {
  const width = Math.min(Math.max(rect.width, 1), bounds.width);
  const height = Math.min(Math.max(rect.height, 1), bounds.height);
  return {
    x: Math.min(Math.max(rect.x, bounds.x), bounds.x + bounds.width - width),
    y: Math.min(Math.max(rect.y, bounds.y), bounds.y + bounds.height - height),
    width,
    height,
  };
}

export function containsPoint(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}

export function candidateAtPoint(candidates: readonly ScreenshotWindowCandidate[], point: Point): ScreenshotWindowCandidate | null {
  for (const candidate of candidates) {
    if (containsPoint(candidate, point)) return candidate;
  }
  return null;
}

export function subtractRects(rect: Rect, occluders: readonly Rect[]): Rect[] {
  let visible = [rect];
  for (const occluder of occluders) {
    visible = visible.flatMap((part) => {
      const left = Math.max(part.x, occluder.x);
      const top = Math.max(part.y, occluder.y);
      const right = Math.min(part.x + part.width, occluder.x + occluder.width);
      const bottom = Math.min(part.y + part.height, occluder.y + occluder.height);
      if (left >= right || top >= bottom) return [part];
      return [
        { x: part.x, y: part.y, width: part.width, height: top - part.y },
        { x: part.x, y: top, width: left - part.x, height: bottom - top },
        { x: right, y: top, width: part.x + part.width - right, height: bottom - top },
        { x: part.x, y: bottom, width: part.width, height: part.y + part.height - bottom },
      ].filter((piece) => piece.width > 0 && piece.height > 0);
    });
    if (visible.length === 0) break;
  }
  return visible;
}

export function sourcePoint(point: Point, ratioX: number, ratioY: number): Point {
  return { x: Math.round(point.x * ratioX), y: Math.round(point.y * ratioY) };
}

export function displayRect(rect: Rect, ratioX: number, ratioY: number): Rect {
  return {
    x: rect.x / ratioX,
    y: rect.y / ratioY,
    width: rect.width / ratioX,
    height: rect.height / ratioY,
  };
}

export function sourceRect(rect: Rect, ratioX: number, ratioY: number): Rect {
  return {
    x: Math.round(rect.x * ratioX),
    y: Math.round(rect.y * ratioY),
    width: Math.max(1, Math.round(rect.width * ratioX)),
    height: Math.max(1, Math.round(rect.height * ratioY)),
  };
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export function resizeRect(rect: Rect, handle: ResizeHandle, delta: Point, bounds: Rect, options: { centered?: boolean; aspectRatio?: number; minimumSize?: number } = {}): Rect {
  const directionX = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const directionY = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  const originX = options.centered || directionX === 0 ? 0.5 : directionX < 0 ? 1 : 0;
  const originY = options.centered || directionY === 0 ? 0.5 : directionY < 0 ? 1 : 0;
  const anchorX = rect.x + rect.width * originX;
  const anchorY = rect.y + rect.height * originY;
  const maxWidth = originX === 0.5
    ? 2 * Math.min(anchorX - bounds.x, bounds.x + bounds.width - anchorX)
    : originX === 1 ? anchorX - bounds.x : bounds.x + bounds.width - anchorX;
  const maxHeight = originY === 0.5
    ? 2 * Math.min(anchorY - bounds.y, bounds.y + bounds.height - anchorY)
    : originY === 1 ? anchorY - bounds.y : bounds.y + bounds.height - anchorY;
  const factor = options.centered ? 2 : 1;
  const minimum = options.minimumSize ?? MIN_SELECTION_SIZE;
  const ratio = options.aspectRatio;
  let width = rect.width + directionX * delta.x * factor;
  let height = rect.height + directionY * delta.y * factor;
  if (ratio !== undefined) {
    if (directionX === 0 || (directionY !== 0 && Math.abs(delta.y) * ratio > Math.abs(delta.x))) width = height * ratio;
    width = Math.min(maxWidth, maxHeight * ratio, Math.max(minimum, minimum * ratio, width));
    height = width / ratio;
  } else {
    width = Math.min(maxWidth, Math.max(minimum, width));
    height = Math.min(maxHeight, Math.max(minimum, height));
  }
  return { x: anchorX - width * originX, y: anchorY - height * originY, width, height };
}

export function moveRect(rect: Rect, delta: Point, bounds: Rect): Rect {
  return {
    ...rect,
    x: Math.min(Math.max(rect.x + delta.x, bounds.x), bounds.x + bounds.width - rect.width),
    y: Math.min(Math.max(rect.y + delta.y, bounds.y), bounds.y + bounds.height - rect.height),
  };
}

export function drawRect(start: Point, point: Point, bounds: Rect, options: { centered?: boolean; aspectRatio?: number } = {}): Rect {
  const handle = `${point.y < start.y ? 'n' : 's'}${point.x < start.x ? 'w' : 'e'}` as ResizeHandle;
  return resizeRect({ x: start.x, y: start.y, width: 0, height: 0 }, handle, { x: point.x - start.x, y: point.y - start.y }, bounds, { ...options, minimumSize: 0 });
}

export function toolbarPosition(selection: Rect, viewport: { width: number; height: number }, toolbar: { width: number; height: number; rowHeight?: number }, anchor?: Point): Point {
  const gap = 10;
  const width = Math.min(toolbar.width, Math.max(0, viewport.width - gap * 2));
  const height = Math.min(toolbar.height, Math.max(0, viewport.height - gap * 2));
  const rowHeight = Math.min(toolbar.rowHeight ?? height, height);
  const maxX = Math.max(gap, viewport.width - width - gap);
  const maxY = Math.max(gap, viewport.height - height - gap);
  const x = Math.min(Math.max(anchor === undefined ? selection.x + selection.width - width : anchor.x - width / 2, gap), maxX);
  const below = selection.y + selection.height + gap;
  const above = selection.y - rowHeight - gap;
  const outside = [below, above].filter((y) => y >= gap && y + rowHeight <= viewport.height - gap);
  if (outside.length > 0) {
    if (anchor !== undefined) outside.sort((a, b) => Math.abs(a + rowHeight / 2 - anchor.y) - Math.abs(b + rowHeight / 2 - anchor.y));
    const y = outside[0] === above ? selection.y - height - gap : below;
    return { x, y: Math.min(Math.max(y, gap), maxY) };
  }
  const preferred = anchor === undefined
    ? selection.y + selection.height - height - gap
    : anchor.y + gap + rowHeight <= viewport.height - gap ? anchor.y + gap : anchor.y - height - gap;
  return { x, y: Math.min(Math.max(preferred, gap), maxY) };
}
