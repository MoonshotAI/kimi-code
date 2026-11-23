
export interface SubmenuPlacement {
  left: number;
  maxWidth: number;
  flipped: boolean;
}

export function resolveSubmenuPlacement(
  naturalWidth: number,
  parent: { left: number; right: number },
  viewportWidth: number,
  gap: number,
  margin: number,
): SubmenuPlacement {
  const rightRoom = viewportWidth - margin - (parent.right + gap);
  const leftRoom = parent.left - gap - margin;
  const flipped = naturalWidth > rightRoom && leftRoom > rightRoom;
  const maxWidth = Math.min(naturalWidth, flipped ? leftRoom : rightRoom);
  const left = flipped ? parent.left - gap - maxWidth : parent.right + gap;
  return { left, maxWidth, flipped };
}
