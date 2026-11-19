import { isApplePlatform } from './shortcutKeys';

export interface SelectAllKeyEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}


export function isSelectAllKeyEvent(
  event: SelectAllKeyEventLike,
  apple: boolean = isApplePlatform(),
): boolean {
  const selectAllModifier = apple
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  return (
    selectAllModifier &&
    !event.altKey &&
    !event.shiftKey &&
    (event.code === 'KeyA' || event.key.toLowerCase() === 'a') &&
    !event.defaultPrevented
  );
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    typeof HTMLElement !== 'undefined' &&
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest('input, textarea') !== null)
  );
}

export function closestRegion(target: EventTarget | null, selector: string): Element | null {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return null;
  return target.closest(selector);
}

export function selectContentsOf(el: Element): void {
  el.ownerDocument.getSelection()?.selectAllChildren(el);
}
