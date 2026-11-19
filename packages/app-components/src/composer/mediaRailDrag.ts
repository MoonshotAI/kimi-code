export function clampMediaDragTranslate(args: {
  translate: number;
  draggedStart: number;
  draggedSize: number;
  contentStart: number;
  contentEnd: number;
}): number {
  const min = args.contentStart - args.draggedStart;
  const max = args.contentEnd - args.draggedStart - args.draggedSize;
  return Math.max(min, Math.min(max, args.translate));
}

export function mediaPointerIntent(args: {
  pointerType: string;
  deltaX: number;
  deltaY: number;
}): 'pending' | 'drag' | 'scroll' | 'cancel' {
  if (Math.hypot(args.deltaX, args.deltaY) <= 4) return 'pending';
  if (args.pointerType !== 'touch') return 'drag';
  return Math.abs(args.deltaX) >= Math.abs(args.deltaY) ? 'scroll' : 'cancel';
}

export function mediaKeyboardReorderTarget(args: {
  index: number;
  length: number;
  altKey: boolean;
  key: string;
  preventDefault: () => void;
}): number | null {
  if (!args.altKey || (args.key !== 'ArrowLeft' && args.key !== 'ArrowRight')) return null;
  args.preventDefault();
  const target = args.key === 'ArrowLeft' ? args.index - 1 : args.index + 1;
  return target < 0 || target >= args.length ? null : target;
}

export function mediaDropIndicatorCenter(args: {
  targetIndex: number;
  contentStart: number;
  slots: readonly { start: number; size: number }[];
}): number | null {
  const after = args.slots[args.targetIndex];
  if (after === undefined) return null;
  if (args.targetIndex === 0) return (args.contentStart + after.start) / 2;
  const before = args.slots[args.targetIndex - 1];
  if (before === undefined) return null;
  return (before.start + before.size + after.start) / 2;
}
