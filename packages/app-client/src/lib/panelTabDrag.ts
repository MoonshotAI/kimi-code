export interface PanelTabSlot {
  id: string;
  start: number;
  size: number;
}

export function panelTabDropIndex(slots: readonly PanelTabSlot[], id: string, contentX: number): number {
  let index = 0;
  for (const slot of slots) {
    if (slot.id === id) continue;
    if (contentX < slot.start + slot.size / 2) return index;
    index += 1;
  }
  return index;
}

export function panelTabInsertLeft(slots: readonly PanelTabSlot[], index: number, gap: number): number {
  const next = slots[index];
  const last = slots.at(-1);
  const left = next ? next.start - gap / 2 : last ? last.start + last.size + gap / 2 : 0;
  return Math.max(gap / 2, left);
}

export function reorderedPanelTabs<T extends { id: string }>(tabs: readonly T[], id: string, index: number): T[] | null {
  const from = tabs.findIndex(tab => tab.id === id);
  if (from < 0 || !Number.isFinite(index)) return null;
  const to = Math.max(0, Math.min(tabs.length - 1, Math.trunc(index)));
  if (from === to) return null;
  const next = [...tabs];
  const [tab] = next.splice(from, 1);
  next.splice(to, 0, tab!);
  return next;
}

export function panelTabSlotStart(slots: readonly PanelTabSlot[], from: number, to: number): number {
  const source = slots[from];
  const target = slots[to];
  if (!source || !target) return source?.start ?? 0;
  return from < to ? target.start + target.size - source.size : target.start;
}

export function panelTabPreviewOffset(index: number, from: number, to: number, draggedSize: number, gap: number): number {
  if (from < to && index > from && index <= to) return -draggedSize - gap;
  if (from > to && index >= to && index < from) return draggedSize + gap;
  return 0;
}

export function panelTabScrollSpeed(pointerX: number, pointerY: number, rect: {
  left: number; right: number; top: number; bottom: number;
}): number {
  if (pointerY < rect.top || pointerY > rect.bottom) return 0;
  const edge = Math.min(48, (rect.right - rect.left) / 3);
  if (edge <= 0) return 0;
  const left = Math.max(0, Math.min(1, (rect.left + edge - pointerX) / edge));
  const right = Math.max(0, Math.min(1, (pointerX - rect.right + edge) / edge));
  return (right - left) * 720;
}
