import { nestedScrollerTakesUpwardScroll, scrollKeyDirection } from '../followScroll';

export const USER_SCROLL_TOLERANCE = 1;
export const SCROLLBAR_FALLBACK_HIT_WIDTH = 12;

export type ScrollInputSource = 'wheel' | 'key' | 'touch';

export type ScrollIntent =
  | { kind: 'scroll'; source: ScrollInputSource; direction: -1 | 0 | 1 }
  | { kind: 'press'; sticky: boolean }
  | { kind: 'drag-start' }
  | { kind: 'drag-end' }
  | { kind: 'touch-start' }
  | { kind: 'touch-end' }
  | { kind: 'scroll-end' };

export function isUnexpectedScroll(top: number, expectedTop: number): boolean {
  return Math.abs(top - expectedTop) > USER_SCROLL_TOLERANCE;
}

export function isScrollbarPointer(event: PointerEvent, scroller: HTMLElement): boolean {
  if (event.target !== scroller) return false;
  const rect = scroller.getBoundingClientRect();
  const gutter = scroller.offsetWidth - scroller.clientWidth;
  return event.clientX >= rect.right - (gutter > 0 ? gutter : SCROLLBAR_FALLBACK_HIT_WIDTH);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null;
}

export function readScrollIntent(event: Event, scroller: HTMLElement): ScrollIntent | null {
  switch (event.type) {
    case 'wheel': {
      const wheel = event as WheelEvent;
      if (wheel.defaultPrevented || wheel.ctrlKey || wheel.shiftKey || wheel.deltaY === 0) return null;
      const direction = wheel.deltaY < 0 ? -1 : 1;
      if (direction < 0 && nestedScrollerTakesUpwardScroll(wheel.composedPath(), scroller)) return null;
      return { kind: 'scroll', source: 'wheel', direction };
    }
    case 'keydown': {
      const key = event as KeyboardEvent;
      if (key.defaultPrevented || key.isComposing || isEditableTarget(key.target)) return null;
      const direction = scrollKeyDirection(key);
      return direction === 0 ? null : { kind: 'scroll', source: 'key', direction };
    }
    case 'pointerdown': {
      const pointer = event as PointerEvent;
      if (pointer.defaultPrevented || pointer.pointerType === 'touch') return null;
      if (pointer.button === 0 && isScrollbarPointer(pointer, scroller)) return { kind: 'drag-start' };
      if (pointer.button === 0) return { kind: 'press', sticky: false };
      return pointer.button === 1 ? { kind: 'press', sticky: true } : null;
    }
    case 'pointerup':
    case 'pointercancel':
      return { kind: 'drag-end' };
    case 'touchstart':
      return { kind: 'touch-start' };
    case 'touchmove':
      return { kind: 'scroll', source: 'touch', direction: 0 };
    case 'touchend':
    case 'touchcancel':
      return { kind: 'touch-end' };
    case 'scrollend':
      return { kind: 'scroll-end' };
    default:
      return null;
  }
}
