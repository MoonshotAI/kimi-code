import { onScopeDispose, ref } from 'vue';

export interface PointerDragPoint {
  x: number;
  y: number;
}

export interface PointerDragStart<T> {
  data: T;
  handle: HTMLElement;
  origin: PointerDragPoint;
  point: PointerDragPoint;
}

export interface PointerDragSessionOptions<T> {
  threshold?: number;
  allowTouch?: boolean;
  enabled?: () => boolean;
  begin: (start: PointerDragStart<T>) => boolean;
  move: (point: PointerDragPoint) => void;
  end: (dropped: boolean, point: PointerDragPoint) => void;
}

export function usePointerDragSession<T>(options: PointerDragSessionOptions<T>) {
  const active = ref(false);
  const threshold = options.threshold ?? 4;
  let pointer: { id: number; data: T; handle: HTMLElement; origin: PointerDragPoint } | null = null;
  let last: PointerDragPoint = { x: 0, y: 0 };
  let suppressClick = false;
  let clickTimer: ReturnType<typeof setTimeout> | undefined;

  function teardown(): { handle: HTMLElement; id: number } | null {
    const previous = pointer;
    pointer = null;
    previous?.handle.removeEventListener('lostpointercapture', onCancel);
    if (previous?.handle.hasPointerCapture(previous.id)) previous.handle.releasePointerCapture(previous.id);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('blur', onCancel);
    return previous;
  }

  function finish(dropped: boolean): void {
    const wasActive = active.value;
    teardown();
    active.value = false;
    if (!wasActive) return;
    suppressClick = true;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { suppressClick = false; }, 0);
    options.end(dropped, last);
  }

  function onMove(event: PointerEvent): void {
    if (!pointer || pointer.id !== event.pointerId) return;
    last = { x: event.clientX, y: event.clientY };
    if (!active.value) {
      if (Math.hypot(last.x - pointer.origin.x, last.y - pointer.origin.y) <= threshold) return;
      const started = options.begin({ data: pointer.data, handle: pointer.handle, origin: pointer.origin, point: last });
      if (!started || !pointer) {
        teardown();
        return;
      }
      active.value = true;
      pointer.handle.blur();
      pointer.handle.setPointerCapture(pointer.id);
      pointer.handle.addEventListener('lostpointercapture', onCancel);
    }
    event.preventDefault();
    options.move(last);
  }

  function onUp(event: PointerEvent): void {
    if (!pointer || event.pointerId !== pointer.id) return;
    last = { x: event.clientX, y: event.clientY };
    finish(true);
  }

  function onCancel(): void { finish(false); }

  function onPointerCancel(event: PointerEvent): void {
    if (event.pointerId === pointer?.id) finish(false);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    finish(false);
  }

  function onPointerDown(event: PointerEvent, data: T): boolean {
    if (
      (event.pointerType === 'touch' && !options.allowTouch) ||
      event.button !== 0 ||
      !event.isPrimary ||
      options.enabled?.() === false ||
      !(event.currentTarget instanceof HTMLElement)
    ) {
      return false;
    }
    finish(false);
    clearTimeout(clickTimer);
    suppressClick = false;
    last = { x: event.clientX, y: event.clientY };
    pointer = { id: event.pointerId, data, handle: event.currentTarget, origin: last };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeydown, true);
    window.addEventListener('blur', onCancel);
    return true;
  }

  function cancel(): void {
    finish(false);
  }

  function consumeClick(): boolean {
    const consumed = suppressClick;
    suppressClick = false;
    return consumed;
  }

  onScopeDispose(() => {
    finish(false);
    clearTimeout(clickTimer);
  });

  return { active, onPointerDown, cancel, consumeClick, pending: () => pointer !== null };
}

export function settleDraggedElement(element: HTMLElement, dx: number, dy: number): Animation | null {
  if (!element.isConnected || typeof element.animate !== 'function') return null;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return null;
  const style = getComputedStyle(element);
  const duration = style.getPropertyValue('--duration-fast').trim();
  const milliseconds = Number.parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  return element.animate([
    { transform: `translate3d(${dx}px, ${dy}px, 0)` },
    { transform: 'translate3d(0, 0, 0)' },
  ], { duration: milliseconds, easing: style.getPropertyValue('--ease-in-out').trim() || 'ease-in-out' });
}
