import { ref, type Ref } from 'vue';
import {
  SELECTION_QUOTE_ENABLED,
  type SelectionActionPayload,
  type SelectionQuoteAnchor,
} from '@moonshot-ai/app-client/lib';

export interface XtermSelectionSource {
  getSelection(): string;
  hasSelection(): boolean;
  clearSelection(): void;
  onSelectionChange(listener: () => void): { dispose(): void };
}

export interface TerminalSelectionQuoteOptions {
  onAction: (payload: SelectionActionPayload) => void;
}

export interface TerminalSelectionQuote {
  anchor: Ref<SelectionQuoteAnchor | null>;
  attach: (term: XtermSelectionSource) => void;
  detach: () => void;
  dismiss: () => void;
  onHostPointerdown: () => void;
  onHostMouseup: (e: MouseEvent) => void;
  onBubbleClose: () => void;
  onBubbleAction: (payload: SelectionActionPayload) => void;
}

export function useTerminalSelectionQuote(options: TerminalSelectionQuoteOptions): TerminalSelectionQuote {
  const anchor = ref<SelectionQuoteAnchor | null>(null);
  let term: XtermSelectionSource | null = null;
  let disposeSelection: (() => void) | null = null;
  let dismissed = false;
  let pointerDown = false;

  function readQuote(): string | null {
    if (term === null || !term.hasSelection()) return null;
    const quote = term.getSelection().replace(/^\n+|\n+$/g, '');
    return quote.trim().length === 0 ? null : quote;
  }

  function refresh(pointer: { x: number; y: number }): void {
    if (!SELECTION_QUOTE_ENABLED) return;
    setTimeout(() => {
      const quote = dismissed ? null : readQuote();
      anchor.value =
        quote === null
          ? null
          : { x: pointer.x, y: pointer.y, bottom: pointer.y, px: pointer.x, py: pointer.y, quote };
    }, 0);
  }

  function onDocPointerUp(e: PointerEvent): void {
    if (!pointerDown) return;
    pointerDown = false;
    if (e.button !== 0) return;
    refresh({ x: e.clientX, y: e.clientY });
  }

  function attach(next: XtermSelectionSource): void {
    detach();
    term = next;
    const subscription = next.onSelectionChange(() => {
      dismissed = false;
      if (!next.hasSelection()) anchor.value = null;
    });
    disposeSelection = () => subscription.dispose();
    if (typeof document !== 'undefined') {
      document.addEventListener('pointerup', onDocPointerUp);
      document.addEventListener('pointercancel', onDocPointerUp);
    }
  }

  function detach(): void {
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerup', onDocPointerUp);
      document.removeEventListener('pointercancel', onDocPointerUp);
    }
    disposeSelection?.();
    disposeSelection = null;
    term = null;
    anchor.value = null;
    dismissed = false;
    pointerDown = false;
  }

  function dismiss(): void {
    anchor.value = null;
    dismissed = true;
  }

  function onHostPointerdown(): void {
    pointerDown = true;
  }

  function onHostMouseup(e: MouseEvent): void {
    if (e.button !== 0) return;
    refresh({ x: e.clientX, y: e.clientY });
  }

  function onBubbleClose(): void {
    dismiss();
  }

  function onBubbleAction(payload: SelectionActionPayload): void {
    anchor.value = null;
    term?.clearSelection();
    options.onAction(payload);
  }

  return { anchor, attach, detach, dismiss, onHostPointerdown, onHostMouseup, onBubbleClose, onBubbleAction };
}
