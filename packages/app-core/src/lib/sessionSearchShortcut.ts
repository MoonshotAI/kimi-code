// packages/app-core/src/lib/sessionSearchShortcut.ts

// Session search chord (⌘K on Apple, Ctrl+K elsewhere): the Spotlight-style
// session dialog opened from the sidebar. Platform-EXACT matching, the same
// idiom as transcriptSearch.ts's ⌘F / transcriptSelectAll.ts's ⌘A: on macOS a
// plain Ctrl+K is the system "delete to end of line" text edit (readline/
// emacs convention, native to every text field), so the app must never
// intercept it there — only ⌘K opens the dialog.

import { isApplePlatform } from './transcriptSelectAll';

export interface SessionSearchKeyEventLike {
  key: string;
  /** Physical key code (KeyboardEvent.code) — layout-independent. */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
}

/** Exact platform session-search chord — ⌘K on Apple, Ctrl+K elsewhere, no
 *  other modifiers held: ⌃⌘K / ⇧⌘K are different chords that stay available,
 *  and an already-consumed key is left alone. Matches the physical K key
 *  first (`code === 'KeyK'`) so non-Latin layouts still fire, with `key` as
 *  the fallback — the idiom transcriptSearch.ts uses for the same class of
 *  layout issue. */
export function isSessionSearchKeyEvent(
  event: SessionSearchKeyEventLike,
  apple: boolean = isApplePlatform(),
): boolean {
  const searchModifier = apple
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  return (
    searchModifier &&
    !event.altKey &&
    !event.shiftKey &&
    (event.code === 'KeyK' || event.key.toLowerCase() === 'k') &&
    !event.defaultPrevented
  );
}
