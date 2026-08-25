// packages/app-client/src/composables/useSelectionQuoteBubble.ts
// The selection quote bubble (划词) trigger logic, extracted for surfaces
// OTHER than the transcript: ChatPane keeps its own inline copy (same logic,
// scoped to `.a-msg .msg` via the default selector); the detail panel's file
// preview mounts a second bubble through this composable, scoped to
// `.file-preview .fp-body`. The bubble component itself is dumb — everything
// here recomputes from the live Selection.
import { onMounted, onUnmounted, ref, type Ref } from 'vue';
import { selectionOwnedByRoot, selectionQuoteAnchor, type SelectionActionPayload, type SelectionQuoteAnchor } from '../lib/quoteSelection';

export interface UseSelectionQuoteBubbleOptions {
  /** The subtree root the bubble is scoped to (the detail-panel aside): the
   *  delegated mouseup/pointerdown handlers live on it in the host's template,
   *  it is the ownership gate for the document-level entries, and the bubble
   *  returns focus to it. */
  root: Ref<HTMLElement | null>;
  /** The container both range ends must share (quote anchor rule) — e.g.
   *  FILE_PREVIEW_QUOTE_CONTAINER for the file preview. */
  containerSelector: string;
  /** The user picked one of the bubble's exits — state and the DOM selection
   *  are already cleared when this runs. */
  onAction: (payload: SelectionActionPayload) => void;
}

export interface SelectionQuoteBubble {
  selectionBubble: Ref<SelectionQuoteAnchor | null>;
  /** True when the last selection gesture was keyboard-driven (Shift+Arrows /
      cursor browse mode) — the bubble focuses its first item for a keyboard
      open only (mouse opens keep focus in place). */
  selectionKeyboard: Ref<boolean>;
  onMouseup: () => void;
  onPointerdown: () => void;
  onBubbleClose: () => void;
  onBubbleAction: (payload: SelectionActionPayload) => void;
}

/** Wire the bubble's selection detection for one surface. Delegated mouseup
 *  on the root PLUS document-level keyup (keyboard selections — Shift+Arrows,
 *  caret browsing — fire no mouseup, and the surface root is NOT focusable,
 *  so a delegated keyup would miss gestures whose focus sits on <body>): a
 *  non-collapsed selection whose range sits ENTIRELY inside one
 *  containerSelector ancestor pops the bubble, anchored to the selection
 *  rect; anything else (plain click, caret typing) closes it. The bubble
 *  itself owns outside-click / Esc / scroll dismissal. */
export function useSelectionQuoteBubble(options: UseSelectionQuoteBubbleOptions): SelectionQuoteBubble {
  const selectionBubble = ref<SelectionQuoteAnchor | null>(null);
  const selectionKeyboard = ref(false);
  // DISMISS latch: an outside dismiss (Esc / scroll / outside click) is FINAL
  // while the DOM selection it dismissed survives — see onBubbleClose and the
  // selectionchange re-arm below.
  let dismissed = false;

  function refreshSelectionBubble(): void {
    // Deferred: at mouseup/keyup time the selection may not reflect the
    // just-finished gesture yet (same pattern as the prototype's setTimeout(0)).
    setTimeout(() => {
      // A dismissed bubble stays dismissed while the selection that opened it
      // survives untouched (see onBubbleClose): a stray keyup (Tab, a
      // shortcut) re-evaluates the STALE selection and would otherwise revive
      // the bubble — now with focus stolen, since the keyup marks the open
      // keyboard-driven.
      selectionBubble.value = dismissed ? null : selectionQuoteAnchor(window.getSelection(), options.containerSelector);
    }, 0);
  }

  function onMouseup(): void {
    selectionKeyboard.value = false;
    refreshSelectionBubble();
  }

  function onPointerdown(): void {
    // Any pointer gesture (mouse, touch, pen) restores the source semantics —
    // a sticky true from an earlier keyup must not misread a later touch-handle
    // selection as keyboard-driven and steal the native handles' focus.
    selectionKeyboard.value = false;
  }

  // Any non-Esc keyup anywhere is a TENTATIVE keyboard hint: the flag only
  // matters when a bubble actually OPENS, which requires a live selection
  // inside the container — so a keyup typed into an unrelated input can set
  // it, but the next pointer gesture resets it before the following open, and
  // a focus-on-open only ever results from a genuinely keyboard-made
  // selection in the surface. (The Esc skip: the bubble's own Esc handling
  // keeps the DOM selection in place — an Esc keyup must not immediately
  // reopen the bubble it just closed.)
  function onDocKeyup(e: KeyboardEvent): void {
    if (e.key === 'Escape') return;
    selectionKeyboard.value = true;
    refreshSelectionBubble();
  }

  // Touch devices adjust the selection through native handles — no mouseup or
  // keyup fires, only selectionchange. Debounce it (~250ms) through the same
  // deferred evaluation; it is idempotent with the mouseup/keyup entries (all
  // recompute from the live selection) and cheap when idle (a collapsed caret
  // just re-closes an already-closed state — a null→null ref write does not
  // re-render). While focus sits INSIDE a bubble (comment input, menu
  // interaction — `.sab` is shared with the transcript's bubble) the refresh
  // is skipped entirely: the bubble is mid-interaction and must not be
  // re-anchored or closed from under the user. The refresh is also
  // OWNERSHIP-GATED: a live selection belonging to another surface (the
  // transcript — or anywhere outside the root) closes ours instead of
  // re-anchoring to it.
  const SELECTION_CHANGE_DEBOUNCE_MS = 250;
  let selectionChangeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSelectionChangeTimer(): void {
    if (selectionChangeTimer !== null) {
      clearTimeout(selectionChangeTimer);
      selectionChangeTimer = null;
    }
  }

  function onDocSelectionChange(): void {
    // Any GENUINE selection gesture re-arms the dismiss latch: selectionchange
    // fires for collapses and growths alike (and typically lands BEFORE the
    // gesture's keyup), while a stale selection emits nothing — so the first
    // Shift+Arrow after an Esc dismiss reopens the bubble (keyboard entry
    // preserved), but a stray keyup never does.
    dismissed = false;
    if (selectionChangeTimer !== null) clearTimeout(selectionChangeTimer);
    selectionChangeTimer = setTimeout(() => {
      selectionChangeTimer = null;
      const active = document.activeElement;
      if (active instanceof Element && active.closest('.sab')) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && !selectionOwnedByRoot(sel, options.root.value)) {
        // The live selection belongs to another surface — close ours if open,
        // never re-anchor to someone else's text.
        selectionBubble.value = null;
        return;
      }
      refreshSelectionBubble();
    }, SELECTION_CHANGE_DEBOUNCE_MS);
  }

  onMounted(() => {
    document.addEventListener('selectionchange', onDocSelectionChange);
    document.addEventListener('keyup', onDocKeyup);
  });
  onUnmounted(() => {
    document.removeEventListener('selectionchange', onDocSelectionChange);
    document.removeEventListener('keyup', onDocKeyup);
    clearSelectionChangeTimer();
  });

  function onBubbleClose(): void {
    selectionBubble.value = null;
    // An outside dismiss (scroll / outside click / Esc) is FINAL: the DOM
    // selection survives it, so every later refresh (stray keyup, a queued
    // selectionchange) must keep the bubble closed instead of re-anchoring
    // to the still-live selection. The latch re-arms on the next
    // selectionchange — any genuinely new gesture fires one; the stale
    // selection emits nothing. Also cancel the pending debounce timer: a
    // selectionchange refresh queued inside the debounce window would
    // re-anchor before the latch change could matter.
    dismissed = true;
    clearSelectionChangeTimer();
  }

  function onBubbleAction(payload: SelectionActionPayload): void {
    selectionBubble.value = null;
    window.getSelection()?.removeAllRanges();
    options.onAction(payload);
  }

  return { selectionBubble, selectionKeyboard, onMouseup, onPointerdown, onBubbleClose, onBubbleAction };
}
