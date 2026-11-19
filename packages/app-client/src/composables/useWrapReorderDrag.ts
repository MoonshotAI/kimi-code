import { nextTick, onScopeDispose, ref, shallowRef, watch, type CSSProperties, type Ref } from 'vue';
import { wrapDropIndex, wrapPreviewOffsets, type WrapFrame, type WrapSlot } from '../lib/wrapReorder';
import { settleDraggedElement, usePointerDragSession, type PointerDragStart } from './usePointerDragSession';

export function useWrapReorderDrag(options: {
  ids: () => readonly string[];
  container: Ref<HTMLElement | null | undefined>;
  move: (id: string, index: number) => void;
  enabled?: () => boolean;
}) {
  const draggingId = ref<string | null>(null);
  const dropIndex = ref<number | null>(null);
  const offset = ref({ x: 0, y: 0 });
  const slots = shallowRef<WrapSlot[]>([]);
  const previews = shallowRef<{ x: number; y: number }[]>([]);
  let drag: { id: string; index: number; item: HTMLElement; origin: { x: number; y: number }; bounds: DOMRect } | null = null;
  let frame: WrapFrame = { left: 0, top: 0, right: 0, columnGap: 0, rowGap: 0 };
  let point = { x: 0, y: 0 };
  let raf = 0;
  let settling: Animation | null = null;
  let generation = 0;

  function update(): void {
    raf = 0;
    if (!drag) return;
    const source = slots.value[drag.index];
    if (!source) return;
    const minX = frame.left - source.left;
    const maxX = frame.right - source.left - source.width;
    const minY = -source.top;
    const maxY = drag.bounds.height - source.top - source.height;
    offset.value = {
      x: Math.max(minX, Math.min(maxX, point.x - drag.origin.x)),
      y: Math.max(minY, Math.min(Math.max(minY, maxY), point.y - drag.origin.y)),
    };
    const to = wrapDropIndex(slots.value, drag.index, offset.value, frame);
    if (to !== dropIndex.value) {
      dropIndex.value = to;
      previews.value = wrapPreviewOffsets(slots.value, drag.index, to, frame);
    }
  }

  function schedule(): void {
    if (!raf && drag) raf = requestAnimationFrame(update);
  }

  function cleanup(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    drag = null;
    draggingId.value = null;
    dropIndex.value = null;
    offset.value = { x: 0, y: 0 };
    slots.value = [];
    previews.value = [];
  }

  function begin(start: PointerDragStart<string>): boolean {
    const container = options.container.value;
    const item = start.handle.closest<HTMLElement>('[data-reorder-id]');
    if (!container || !item) return false;
    const bounds = container.getBoundingClientRect();
    const measured = [...container.querySelectorAll<HTMLElement>('[data-reorder-id]')].map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: element.dataset['reorderId']!, left: rect.left - bounds.left, top: rect.top - bounds.top, width: rect.width, height: rect.height };
    });
    const index = measured.findIndex((slot) => slot.id === start.data);
    if (index < 0) return false;
    const style = getComputedStyle(container);
    const first = measured[0]!;
    frame = {
      left: first.left,
      top: first.top,
      right: bounds.width - (Number.parseFloat(style.paddingRight) || 0) - (Number.parseFloat(style.borderRightWidth) || 0),
      columnGap: Number.parseFloat(style.columnGap) || 0,
      rowGap: Number.parseFloat(style.rowGap) || 0,
    };
    slots.value = measured;
    previews.value = measured.map(() => ({ x: 0, y: 0 }));
    drag = { id: start.data, index, item, origin: start.origin, bounds };
    point = start.point;
    dropIndex.value = index;
    draggingId.value = start.data;
    update();
    return true;
  }

  function end(dropped: boolean, last: { x: number; y: number }): void {
    const previous = drag;
    if (!previous) return;
    point = last;
    if (dropped) update();
    const to = dropIndex.value;
    const source = slots.value[previous.index];
    const visual = previous.item.getBoundingClientRect();
    cleanup();
    const current = ++generation;
    if (dropped && to !== null && to !== previous.index && source) options.move(previous.id, to);
    void nextTick(() => {
      if (generation !== current) return;
      const settled = previous.item.getBoundingClientRect();
      settling = settleDraggedElement(previous.item, visual.left - settled.left, visual.top - settled.top);
    });
  }

  const session = usePointerDragSession<string>({
    enabled: options.enabled,
    begin,
    move: (next) => {
      point = next;
      schedule();
    },
    end,
  });

  function onPointerDown(event: PointerEvent, id: string): void {
    if (!session.onPointerDown(event, id)) return;
    settling?.cancel();
    settling = null;
  }

  function styleFor(id: string): CSSProperties | undefined {
    if (!drag || draggingId.value === null) return undefined;
    if (id === draggingId.value) return { transform: `translate3d(${offset.value.x}px, ${offset.value.y}px, 0)` };
    const index = slots.value.findIndex((slot) => slot.id === id);
    const preview = previews.value[index];
    if (!preview) return undefined;
    return { transform: `translate3d(${preview.x}px, ${preview.y}px, 0)` };
  }

  function cancel(): void {
    session.cancel();
    cleanup();
  }

  watch(() => options.ids().join('\u0000'), () => { if (session.pending()) cancel(); });
  onScopeDispose(() => { cancel(); settling?.cancel(); });

  return { draggingId, dropIndex, styleFor, onPointerDown, cancel, consumeClick: session.consumeClick };
}
