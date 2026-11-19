export interface WrapSlot {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WrapFrame {
  left: number;
  top: number;
  right: number;
  columnGap: number;
  rowGap: number;
}

export function wrapLayout(
  sizes: readonly { width: number; height: number }[],
  frame: WrapFrame,
): { left: number; top: number }[] {
  let x = frame.left;
  let y = frame.top;
  let rowHeight = 0;
  return sizes.map(({ width, height }) => {
    if (x > frame.left && x + width > frame.right) {
      x = frame.left;
      y += rowHeight + frame.rowGap;
      rowHeight = 0;
    }
    const position = { left: x, top: y };
    x += width + frame.columnGap;
    rowHeight = Math.max(rowHeight, height);
    return position;
  });
}

export function wrapDropIndex(
  slots: readonly WrapSlot[],
  from: number,
  offset: { x: number; y: number },
  frame: WrapFrame,
): number {
  const source = slots[from];
  if (!source) return from;
  const others = slots.filter((_, index) => index !== from);
  if (others.length === 0) return 0;
  const rows: WrapSlot[][] = [];
  for (const slot of others) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0]!.top - slot.top) < row[0]!.height / 2) row.push(slot);
    else rows.push([slot]);
  }
  const left = source.left + offset.x;
  const top = source.top + offset.y;
  const y = top + source.height / 2;
  let row = rows[0]!;
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of rows) {
    const rowTop = candidate[0]!.top;
    const bottom = Math.max(...candidate.map((slot) => slot.top + slot.height));
    const distance = y < rowTop ? rowTop - y : y > bottom ? y - bottom : 0;
    if (distance < best) {
      best = distance;
      row = candidate;
    }
  }
  const before = others.indexOf(row[0]!);
  let index = before;
  let nearest = Number.POSITIVE_INFINITY;
  for (let to = before; to <= before + row.length; to++) {
    const placed = wrapLayout(movedOrder(slots, from, to), frame)[to]!;
    const distance = Math.hypot(placed.left - left, placed.top - top);
    if (distance < nearest) {
      nearest = distance;
      index = to;
    }
  }
  return index;
}

export function movedOrder<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
  return next;
}

export function wrapPreviewOffsets(
  slots: readonly WrapSlot[],
  from: number,
  to: number,
  frame: WrapFrame,
): { x: number; y: number }[] {
  const order = movedOrder(slots.map((_, index) => index), from, to);
  const placed = wrapLayout(order.map((index) => slots[index]!), frame);
  const offsets = slots.map(() => ({ x: 0, y: 0 }));
  order.forEach((index, position) => {
    const slot = slots[index]!;
    const target = placed[position]!;
    offsets[index] = { x: target.left - slot.left, y: target.top - slot.top };
  });
  return offsets;
}
