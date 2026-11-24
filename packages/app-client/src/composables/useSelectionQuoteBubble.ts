import { onMounted, onUnmounted, ref, type Ref } from 'vue';
import { SELECTION_QUOTE_ENABLED, selectionOwnedByRoot, selectionQuoteAnchor, type SelectionActionPayload, type SelectionQuoteAnchor } from '../lib/quoteSelection';

export interface UseSelectionQuoteBubbleOptions {
  root: Ref<HTMLElement | null>;
  containerSelector: string;
  captureSource?: (sel: Selection | null) => string | undefined;
  onAction: (payload: SelectionActionPayload, source?: string) => void;
}

export interface SelectionQuoteBubble {
  selectionBubble: Ref<SelectionQuoteAnchor | null>;
  selectionKeyboard: Ref<boolean>;
  onMouseup: (e?: MouseEvent) => void;
  onPointerdown: () => void;
  onBubbleClose: () => void;
  onBubbleAction: (payload: SelectionActionPayload) => void;
}

export function useSelectionQuoteBubble(options: UseSelectionQuoteBubbleOptions): SelectionQuoteBubble {
  const selectionBubble = ref<SelectionQuoteAnchor | null>(null);
  const selectionKeyboard = ref(false);
  let dismissed = false;
  let pointerDown = false;
  let quoteSource: string | undefined;

  function refreshSelectionBubble(pointer?: { x: number; y: number }): void {
    if (!SELECTION_QUOTE_ENABLED) return;
    setTimeout(() => {
      const anchor = dismissed ? null : selectionQuoteAnchor(window.getSelection(), options.containerSelector);
      if (anchor !== null) {
        const prev = selectionBubble.value;
        const carry =
          prev !== null && prev.quote === anchor.quote && prev.x === anchor.x && prev.y === anchor.y && prev.bottom === anchor.bottom ? prev : null;
        const px = pointer?.x ?? carry?.px;
        const py = pointer?.y ?? carry?.py;
        if (px !== undefined && py !== undefined) {
          anchor.px = px;
          anchor.py = py;
        }
      }
      selectionBubble.value = anchor;
      quoteSource = anchor === null ? undefined : options.captureSource?.(window.getSelection());
    }, 0);
  }

  function onMouseup(e?: MouseEvent): void {
    selectionKeyboard.value = false;
    refreshSelectionBubble(e !== undefined && (e.clientX || e.clientY) ? { x: e.clientX, y: e.clientY } : undefined);
  }

  function onPointerdown(): void {
    pointerDown = true;
    selectionKeyboard.value = false;
  }

  function onDocPointerUp(e: PointerEvent): void {
    if (!pointerDown) return;
    pointerDown = false;
    if (e.button !== 0) return;
    refreshSelectionBubble();
  }

  function onDocKeyup(e: KeyboardEvent): void {
    if (e.key === 'Escape') return;
    if (e.target instanceof Element && e.target.closest('.sab')) return;
    selectionKeyboard.value = true;
    refreshSelectionBubble();
  }

  const SELECTION_CHANGE_DEBOUNCE_MS = 250;
  let selectionChangeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSelectionChangeTimer(): void {
    if (selectionChangeTimer !== null) {
      clearTimeout(selectionChangeTimer);
      selectionChangeTimer = null;
    }
  }

  function onDocSelectionChange(): void {
    dismissed = false;
    if (selectionChangeTimer !== null) clearTimeout(selectionChangeTimer);
    selectionChangeTimer = setTimeout(() => {
      selectionChangeTimer = null;
      const active = document.activeElement;
      if (active instanceof Element && active.closest('.sab')) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && !selectionOwnedByRoot(sel, options.root.value)) {
        selectionBubble.value = null;
        return;
      }
      if (pointerDown) return;
      refreshSelectionBubble();
    }, SELECTION_CHANGE_DEBOUNCE_MS);
  }

  onMounted(() => {
    if (!SELECTION_QUOTE_ENABLED) return;
    document.addEventListener('selectionchange', onDocSelectionChange);
    document.addEventListener('keyup', onDocKeyup);
    document.addEventListener('pointerup', onDocPointerUp);
    document.addEventListener('pointercancel', onDocPointerUp);
  });
  onUnmounted(() => {
    document.removeEventListener('selectionchange', onDocSelectionChange);
    document.removeEventListener('keyup', onDocKeyup);
    document.removeEventListener('pointerup', onDocPointerUp);
    document.removeEventListener('pointercancel', onDocPointerUp);
    clearSelectionChangeTimer();
  });

  function onBubbleClose(): void {
    selectionBubble.value = null;
    dismissed = true;
    clearSelectionChangeTimer();
  }

  function onBubbleAction(payload: SelectionActionPayload): void {
    selectionBubble.value = null;
    const source = quoteSource;
    quoteSource = undefined;
    window.getSelection()?.removeAllRanges();
    options.onAction(payload, source);
  }

  return { selectionBubble, selectionKeyboard, onMouseup, onPointerdown, onBubbleClose, onBubbleAction };
}
