import { nextTick, onScopeDispose, ref, shallowRef, watch, type CSSProperties, type Ref } from 'vue';
import { settleDraggedElement, usePointerDragSession, type PointerDragStart } from './usePointerDragSession';
import {
  panelTabDropIndex,
  panelTabPreviewOffset,
  panelTabScrollSpeed,
  panelTabSlotStart,
  type PanelTabSlot,
} from '../lib/panelTabDrag';

export function usePanelTabDrag(options: {
  tabs: () => readonly { id: string }[];
  container: Ref<HTMLElement | null>;
  move: (id: string, index: number) => void;
  start?: () => void;
  enabled?: () => boolean;
  external?: {
    hover: (x: number, y: number, id: string) => number | null;
    commit: (id: string, index: number) => void;
    clear: () => void;
  };
}) {
  const draggingId = ref<string | null>(null);
  const dropIndex = ref<number | null>(null);
  const indicatorLeft = ref<number | null>(null);
  const translateX = ref(0);
  const slots = shallowRef<PanelTabSlot[]>([]);
  const preview = ref<{ x: number; y: number } | null>(null);
  let pointer: {
    tabId: string; index: number; tab: HTMLElement; container: HTMLElement; grabOffset: number; grabY: number;
  } | null = null;
  let ghost: HTMLElement | null = null;
  let inside = true;
  let gap = 0;
  let indexById = new Map<string, number>();
  let lastX = 0;
  let lastY = 0;
  let frame = 0;
  let lastFrameTime: number | null = null;
  let settling: Animation | null = null;
  let generation = 0;
  let externalIndex: number | null = null;

  function updatePreview(): void {
    if (!pointer || draggingId.value === null) return;
    const container = pointer.container;
    const rect = container.getBoundingClientRect();
    const pointX = Math.max(rect.left, Math.min(rect.right, lastX));
    const source = slots.value[pointer.index];
    const first = slots.value[0];
    const last = slots.value.at(-1);
    if (!source || !first || !last) return;
    inside = withinBar(rect);
    externalIndex = options.external?.hover(lastX, lastY, pointer.tabId) ?? null;
    if (!inside || externalIndex !== null) {
      translateX.value = 0;
      dropIndex.value = pointer.index;
      indicatorLeft.value = null;
      preview.value = { x: lastX - pointer.grabOffset, y: lastY - pointer.grabY };
      showGhost(preview.value);
      return;
    }
    hideGhost();
    const desired = pointX - rect.left + container.scrollLeft - pointer.grabOffset - source.start;
    translateX.value = Math.max(first.start - source.start,
      Math.min(last.start + last.size - source.start - source.size, desired));
    const to = panelTabDropIndex(slots.value, pointer.tabId, pointX - rect.left + container.scrollLeft);
    dropIndex.value = to;
    indicatorLeft.value = Math.max(gap / 2, panelTabSlotStart(slots.value, pointer.index, to) - gap / 2);
  }

  function withinBar(rect: DOMRect): boolean {
    const tolerance = rect.height / 2;
    return lastY >= rect.top - tolerance && lastY <= rect.bottom + tolerance;
  }

  function showGhost(position: { x: number; y: number }): void {
    if (!pointer) return;
    if (!ghost) {
      const rect = pointer.tab.getBoundingClientRect();
      ghost = pointer.tab.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('style');
      ghost.removeAttribute('data-panel-tab-id');
      for (const node of ghost.querySelectorAll('[data-tab-id], [id]')) {
        node.removeAttribute('data-tab-id');
        node.removeAttribute('id');
      }
      ghost.classList.remove('is-dragging', 'is-entering');
      ghost.classList.add('is-drag-ghost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.setAttribute('inert', '');
      Object.assign(ghost.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        margin: '0',
        width: `${rect.width}px`,
        minWidth: `${rect.width}px`,
        maxWidth: `${rect.width}px`,
        height: `${rect.height}px`,
        pointerEvents: 'none',
        zIndex: 'var(--z-max)',
      });
      document.body.append(ghost);
    }
    ghost.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
  }

  function hideGhost(): void {
    ghost?.remove();
    ghost = null;
    preview.value = null;
  }

  function scheduleFrame(): void {
    if (!frame && draggingId.value !== null) frame = requestAnimationFrame(updateFrame);
  }

  function updateFrame(time: number): void {
    frame = 0;
    if (!pointer || draggingId.value === null) return;
    const container = pointer.container;
    const rect = container.getBoundingClientRect();
    inside = withinBar(rect);
    const speed = inside ? panelTabScrollSpeed(lastX, lastY, rect) : 0;
    const elapsed = lastFrameTime === null ? 1000 / 60 : Math.min(32, time - lastFrameTime);
    lastFrameTime = time;
    const before = container.scrollLeft;
    const next = Math.max(0, Math.min(container.scrollWidth - container.clientWidth, before + speed * elapsed / 1000));
    if (next !== before) container.scrollLeft = next;
    updatePreview();
    if (speed !== 0 && container.scrollLeft !== before) scheduleFrame();
    else lastFrameTime = null;
  }

  function styleFor(id: string): CSSProperties | undefined {
    if (draggingId.value === null || !pointer || dropIndex.value === null) return undefined;
    const index = indexById.get(id) ?? -1;
    const slot = slots.value[index];
    const source = slots.value[pointer.index];
    if (!slot || !source) return undefined;
    const offset = id === draggingId.value ? translateX.value
      : panelTabPreviewOffset(index, pointer.index, dropIndex.value, source.size, gap);
    const style: CSSProperties = { width: `${slot.size}px`, minWidth: `${slot.size}px`, maxWidth: `${slot.size}px`, transform: `translate3d(${offset}px, 0, 0)` };
    if (id === draggingId.value && preview.value !== null) style.opacity = 'var(--opacity-hint)';
    return style;
  }

  function cleanup(): void {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastFrameTime = null;
    pointer?.container.removeEventListener('scroll', scheduleFrame);
    hideGhost();
    inside = true;
    pointer = null;
    draggingId.value = null;
    dropIndex.value = null;
    indicatorLeft.value = null;
    translateX.value = 0;
    externalIndex = null;
    slots.value = [];
    indexById.clear();
  }

  function end(dropped: boolean, point: { x: number; y: number }): void {
    const previous = pointer;
    if (!previous) return;
    lastX = point.x;
    lastY = point.y;
    if (dropped) updatePreview();
    const to = dropIndex.value;
    const external = dropped ? externalIndex : null;
    const visualLeft = previous.container.getBoundingClientRect().left - previous.container.scrollLeft
      + (slots.value[previous.index]?.start ?? 0) + translateX.value;
    const commit = dropped && external === null && inside;
    cleanup();
    options.external?.clear();
    const current = ++generation;
    if (external !== null) {
      options.external?.commit(previous.tabId, external);
      return;
    }
    if (!commit || to === null) return;
    if (to !== previous.index) options.move(previous.tabId, to);
    void nextTick(() => {
      if (generation !== current) return;
      settling = settleDraggedElement(previous.tab, visualLeft - previous.tab.getBoundingClientRect().left, 0);
    });
  }

  function begin(start: PointerDragStart<string>): boolean {
    const container = options.container.value;
    const tab = start.handle.closest<HTMLElement>('[data-panel-tab-id]');
    if (!container || !tab) return false;
    const rect = container.getBoundingClientRect();
    slots.value = [...container.querySelectorAll<HTMLElement>('[data-panel-tab-id]')].map(element => {
      const bounds = element.getBoundingClientRect();
      return { id: element.dataset['panelTabId']!, start: bounds.left - rect.left + container.scrollLeft, size: bounds.width };
    });
    indexById = new Map(slots.value.map((slot, index) => [slot.id, index]));
    const index = indexById.get(start.data) ?? -1;
    if (index < 0) {
      slots.value = [];
      indexById.clear();
      return false;
    }
    const tabRect = tab.getBoundingClientRect();
    pointer = { tabId: start.data, index, tab, container, grabOffset: start.origin.x - tabRect.left, grabY: start.origin.y - tabRect.top };
    lastX = start.point.x;
    lastY = start.point.y;
    gap = Number.parseFloat(getComputedStyle(container).columnGap) || 0;
    draggingId.value = start.data;
    container.addEventListener('scroll', scheduleFrame, { passive: true });
    options.start?.();
    updatePreview();
    return true;
  }

  const session = usePointerDragSession<string>({
    enabled: options.enabled,
    begin,
    move: (point) => {
      lastX = point.x;
      lastY = point.y;
      scheduleFrame();
    },
    end,
  });

  function onPointerDown(event: PointerEvent, tabId: string): void {
    if (!options.container.value || !(event.currentTarget instanceof HTMLElement)) return;
    if (!event.currentTarget.closest('[data-panel-tab-id]')) return;
    if (!session.onPointerDown(event, tabId)) return;
    settling?.cancel();
    settling = null;
  }

  function cancel(): void {
    session.cancel();
    cleanup();
  }

  watch(() => options.tabs().map(tab => tab.id).join(','), () => { if (session.pending()) cancel(); });
  watch(() => options.enabled?.() ?? true, enabled => { if (!enabled) cancel(); });
  onScopeDispose(() => { cancel(); settling?.cancel(); });
  return { draggingId, indicatorLeft, preview, styleFor, onPointerDown, consumeClick: session.consumeClick };
}
