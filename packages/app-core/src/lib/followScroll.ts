export const JUMP_PILL_HIDE_DISTANCE = 80;

export function nextJumpPillVisible(visible: boolean, distance: number, viewportHeight: number): boolean {
  if (distance > viewportHeight / 2) return true;
  if (distance <= JUMP_PILL_HIDE_DISTANCE) return false;
  return visible;
}

export interface ScrollKeyEventLike {
  key: string;
  shiftKey: boolean;
}

export function scrollKeyDirection(event: ScrollKeyEventLike): -1 | 0 | 1 {
  switch (event.key) {
    case 'PageUp':
    case 'ArrowUp':
    case 'Home':
      return -1;
    case 'PageDown':
    case 'ArrowDown':
    case 'End':
      return 1;
    case ' ':
      return event.shiftKey ? -1 : 1;
    default:
      return 0;
  }
}

export function nestedScrollerTakesUpwardScroll(path: Iterable<EventTarget>, pane: EventTarget): boolean {
  if (typeof HTMLElement === 'undefined') return false;
  for (const target of path) {
    if (target === pane) return false;
    if (!(target instanceof HTMLElement) || target.scrollHeight <= target.clientHeight + 1) continue;
    if (target.scrollTop > 1) return true;
    const style = getComputedStyle(target);
    if (
      (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
      (style.overscrollBehaviorY === 'contain' || style.overscrollBehaviorY === 'none')
    ) {
      return true;
    }
  }
  return false;
}
