// packages/app-core/src/lib/transcriptSelectAll.ts

// Cmd/Ctrl+A repointing: the browser's select-all paints the selection across
// the whole document (sidebar buttons, panel chrome); route it to the region
// the user is attending to instead — the transcript, or the open detail panel.

export interface SelectAllKeyEventLike {
  key: string;
  /** Physical key code (KeyboardEvent.code) — layout-independent. */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}

/** True on macOS / iOS, where select-all is ⌘A. Mirrors keymap.ts's
 *  isAppleShortcutPlatform (that file is desktop-only; this one is shared). */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/Mac|iPod|iPhone|iPad/.test(navigator.platform)) return true;
  const userAgentData = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData;
  return userAgentData?.platform === 'macOS' || userAgentData?.platform === 'iOS';
}

/** Exact platform select-all — ⌘A on Apple, Ctrl+A elsewhere, with no other
 *  modifiers held: ⌃⌘A and the like are different chords that stay available
 *  for custom keymap bindings, and an already-consumed key is left alone. The
 *  browser fires select-all on the physical A key, so match `code === 'KeyA'`
 *  first (on non-Latin layouts `key` is the localized char, e.g. Cyrillic ф),
 *  with `key` as the fallback — the idiom keymap.ts uses for the same class
 *  of layout issue. */
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

/** Keydowns from inside a text field keep the field's own select-all. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    typeof HTMLElement !== 'undefined' &&
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest('input, textarea') !== null)
  );
}

/** First ancestor-or-self region matching `selector` — select-all routing. */
export function closestRegion(target: EventTarget | null, selector: string): Element | null {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return null;
  return target.closest(selector);
}

/** Select all rendered content of a region element. */
export function selectContentsOf(el: Element): void {
  el.ownerDocument.getSelection()?.selectAllChildren(el);
}
