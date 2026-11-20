import { nextTick, onScopeDispose, ref, shallowRef } from 'vue';

const OPEN_DELAY_MS = 500;
const CLOSE_DELAY_MS = 140;
const CARD_WIDTH = 460;
const ANCHOR_GAP = 12;
const VIEWPORT_MARGIN = 12;

function pointerCanHover(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return true;
  return !window.matchMedia('(hover: none)').matches;
}

export function useSessionHoverCard() {
  const open = ref(false);
  const cardStyle = ref<Record<string, string>>({});
  const cardEl = shallowRef<HTMLElement | null>(null);
  let anchor: { right: number; top: number } | null = null;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  function setCardEl(element: unknown): void {
    const root = (element as { $el?: unknown } | null)?.$el ?? element;
    cardEl.value = root instanceof HTMLElement ? root : null;
  }

  function place(): void {
    if (anchor === null) return;
    const maxWidth = Math.min(CARD_WIDTH, window.innerWidth - 2 * VIEWPORT_MARGIN);
    const width = cardEl.value?.offsetWidth || maxWidth;
    const height = cardEl.value?.offsetHeight ?? 0;
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(anchor.right + ANCHOR_GAP, window.innerWidth - width - VIEWPORT_MARGIN),
    );
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(anchor.top - 4, window.innerHeight - height - VIEWPORT_MARGIN),
    );
    cardStyle.value = {
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
      maxWidth: `${maxWidth}px`,
      maxHeight: `${Math.max(120, window.innerHeight - 2 * VIEWPORT_MARGIN)}px`,
    };
  }

  function onScroll(event: Event): void {
    if (event.target instanceof Node && cardEl.value?.contains(event.target) === true) return;
    close();
  }

  function removeListeners(): void {
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
    document.removeEventListener('scroll', onScroll, true);
  }

  function clearTimers(): void {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    openTimer = undefined;
    closeTimer = undefined;
  }

  function close(): void {
    clearTimers();
    if (!open.value) return;
    open.value = false;
    anchor = null;
    removeListeners();
  }

  function scheduleOpen(target: HTMLElement): void {
    clearTimers();
    if (open.value || !pointerCanHover()) return;
    openTimer = setTimeout(() => {
      openTimer = undefined;
      if (!target.isConnected) return;
      const rect = target.getBoundingClientRect();
      anchor = { right: rect.right, top: rect.top };
      open.value = true;
      place();
      window.addEventListener('resize', close);
      window.addEventListener('blur', close);
      document.addEventListener('scroll', onScroll, true);
      void nextTick(place);
    }, OPEN_DELAY_MS);
  }

  function cancelClose(): void {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }

  function scheduleClose(): void {
    clearTimeout(openTimer);
    openTimer = undefined;
    cancelClose();
    if (!open.value) return;
    closeTimer = setTimeout(close, CLOSE_DELAY_MS);
  }

  onScopeDispose(() => {
    clearTimers();
    removeListeners();
  });

  return { open, cardStyle, setCardEl, scheduleOpen, cancelClose, scheduleClose, close };
}
