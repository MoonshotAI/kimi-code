// packages/app-core/src/lib/submenuPlacement.ts
// Horizontal placement for the user menu's macOS-style flyout submenus —
// single-sourced here so the desktop and web UserMenu mirrors share one
// implementation (and one test).

export interface SubmenuPlacement {
  left: number;
  maxWidth: number;
  flipped: boolean;
}

/** Place a flyout of `naturalWidth` beside its parent menu: it opens on the
    parent's right edge, flipping left only when the content overflows the
    right-side room AND the left side is roomier. The width cap follows the
    chosen side, so a flipped panel is pinned against the parent's left edge
    and can never sprawl back across the parent menu. */
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
