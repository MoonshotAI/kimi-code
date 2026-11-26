export function menuNavigationIndex(key: string, shiftKey: boolean, index: number, count: number): number | null {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(key)) return null;
  if (count === 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const direction = key === 'ArrowUp' || (key === 'Tab' && shiftKey) ? -1 : 1;
  if (index < 0) return direction === -1 ? count - 1 : 0;
  return (index + direction + count) % count;
}

export interface FocusableMenuItem {
  focus(): void;
}

export interface MenuFocusableContainer {
  readonly ownerDocument?: { readonly activeElement?: unknown };
  querySelectorAll(selector: string): Iterable<FocusableMenuItem>;
}

export function focusMenuContainerItem(
  container: MenuFocusableContainer | null | undefined,
  key: string,
  shiftKey = false,
): boolean {
  if (!container) return false;
  const items = Array.from(container.querySelectorAll('.ui-menu-item:not(:disabled)'));
  const active = container.ownerDocument?.activeElement;
  const current = items.findIndex((item) => item === active);
  const next = menuNavigationIndex(key, shiftKey, current, items.length);
  if (next === null || next < 0) return false;
  items[next]?.focus();
  return true;
}
