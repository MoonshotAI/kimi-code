// Pure positioning + scroll-lock helpers for Select's body-teleported menu
// (components/ui/Select.vue). Kept DOM-free so the node test suite can cover
// the geometry; the component only feeds in measured rects and applies the
// returned inline style.

/** Trigger geometry as measured by getBoundingClientRect (only what we need). */
export type SelectMenuAnchor = {
  top: number;
  bottom: number;
  left: number;
  width: number;
};

export type SelectMenuLayout = {
  /** Inline style for the fixed-position menu (`top` xor `bottom` is set, the
      other pinned to 'auto' so flipping never leaves a stale offset). */
  style: Record<string, string>;
  /** True when the menu opens upward (not enough room below the trigger). */
  flipUp: boolean;
};

/**
 * Anchors the fixed-position menu to the trigger: same width (clamped to
 * the viewport minus the side margins), a `gap` below it, and clamped
 * horizontally into the viewport with `margin` clearance.
 * Vertically it opens on the side that fits the menu; when NEITHER side has
 * room (small window, trigger mid-viewport), it takes the roomier side and
 * clamps the menu's max-height to that side's available space so edge
 * options stay reachable instead of falling off-screen.
 */
export function computeSelectMenuLayout(input: {
  anchor: SelectMenuAnchor;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  gap: number;
  margin: number;
}): SelectMenuLayout {
  const { anchor, menuHeight, viewportWidth, viewportHeight, gap, margin } = input;
  // Usable vertical space on each side of the trigger, keeping `margin` off
  // the viewport edge.
  const below = viewportHeight - margin - (anchor.bottom + gap);
  const above = anchor.top - gap - margin;
  const flipUp = below < menuHeight && above > below;
  const available = flipUp ? above : below;
  // Clamp the width as well as the offset: a trigger wider than the viewport
  // (narrow window / full-width control / high zoom) would otherwise pin
  // left at the margin and still overflow the right edge.
  const width = Math.min(anchor.width, Math.max(0, viewportWidth - 2 * margin));
  const left = Math.min(
    Math.max(anchor.left, margin),
    Math.max(margin, viewportWidth - margin - width),
  );
  const style: Record<string, string> = {
    left: `${Math.round(left)}px`,
    width: `${Math.round(width)}px`,
  };
  // Only set when shrinking is needed — otherwise the CSS max-height cap
  // (already reflected in the measured menuHeight) stays in charge.
  if (available < menuHeight) style.maxHeight = `${Math.max(0, Math.round(available))}px`;
  if (flipUp) {
    style.top = 'auto';
    style.bottom = `${Math.round(viewportHeight - anchor.top + gap)}px`;
  } else {
    style.top = `${Math.round(anchor.bottom + gap)}px`;
    style.bottom = 'auto';
  }
  return { style, flipUp };
}

/**
 * While the menu is open, scrolling must not happen behind it (the settings
 * dialog's body would otherwise scroll under the floating listbox). The
 * capture-phase wheel/touchmove guard blocks every scroll gesture whose
 * target is OUTSIDE the menu — the menu itself keeps scrolling normally
 * (overscroll-behavior: contain stops the chain at its own ends).
 */
export function shouldBlockBehindScroll(
  eventTarget: unknown,
  // Structural + DOM-free (this package's tsconfig has no DOM lib): the real
  // call site passes a wheel/touch event target and an HTMLElement, whose
  // `contains` satisfies this bivariantly; tests pass plain stubs.
  menu: { contains(other: unknown): boolean } | null,
): boolean {
  if (menu && eventTarget && menu.contains(eventTarget)) return false;
  return true;
}
