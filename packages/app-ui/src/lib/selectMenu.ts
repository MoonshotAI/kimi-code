
export type SelectMenuAnchor = {
  top: number;
  bottom: number;
  left: number;
  width: number;
};

export type SelectMenuLayout = {
  style: Record<string, string>;
  flipUp: boolean;
};

export function computeSelectMenuLayout(input: {
  anchor: SelectMenuAnchor;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  gap: number;
  margin: number;
  minWidth?: number;
}): SelectMenuLayout {
  const { anchor, menuHeight, viewportWidth, viewportHeight, gap, margin, minWidth = 0 } = input;
  const below = viewportHeight - margin - (anchor.bottom + gap);
  const above = anchor.top - gap - margin;
  const flipUp = below < menuHeight && above > below;
  const available = flipUp ? above : below;
  const width = Math.min(Math.max(anchor.width, minWidth), Math.max(0, viewportWidth - 2 * margin));
  const left = Math.min(
    Math.max(anchor.left, margin),
    Math.max(margin, viewportWidth - margin - width),
  );
  const style: Record<string, string> = {
    left: `${Math.round(left)}px`,
    width: `${Math.round(width)}px`,
  };
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

export function shouldBlockBehindScroll(
  eventTarget: unknown,
  menu: { contains(other: unknown): boolean } | null,
): boolean {
  if (menu && eventTarget && menu.contains(eventTarget)) return false;
  return true;
}
