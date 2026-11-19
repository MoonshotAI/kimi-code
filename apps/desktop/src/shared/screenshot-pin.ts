export const PIN_RESIZE_EDGES = ['top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
export type PinResizeEdge = typeof PIN_RESIZE_EDGES[number];

export function pinResizeEdgeAt(x: number, y: number, width: number, height: number): PinResizeEdge | null {
  const horizontal = x < 6 ? 'left' : x >= width - 6 ? 'right' : '';
  const vertical = y < 6 ? 'top' : y >= height - 6 ? 'bottom' : '';
  return (vertical && horizontal ? `${vertical}-${horizontal}` : vertical || horizontal || null) as PinResizeEdge | null;
}

export function resizePinnedBounds(
  bounds: { x: number; y: number; width: number; height: number },
  area: { x: number; y: number; width: number; height: number },
  edge: PinResizeEdge,
  deltaX: number,
  deltaY: number,
): typeof bounds {
  const horizontal = edge.includes('left') ? -deltaX / bounds.width : edge.includes('right') ? deltaX / bounds.width : 0;
  const vertical = edge.includes('top') ? -deltaY / bounds.height : edge.includes('bottom') ? deltaY / bounds.height : 0;
  const delta = Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical;
  const maximum = Math.min(area.width / bounds.width, area.height / bounds.height);
  const scale = Math.min(maximum, Math.max(Math.min(maximum, Math.max(80 / bounds.width, 60 / bounds.height)), 1 + delta));
  const width = Math.round(bounds.width * scale);
  const height = Math.round(bounds.height * scale);
  const x = edge.includes('left') ? bounds.x + bounds.width - width : bounds.x;
  const y = edge.includes('top') ? bounds.y + bounds.height - height : bounds.y;
  return {
    x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, y))),
    width,
    height,
  };
}
