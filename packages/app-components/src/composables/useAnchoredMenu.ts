import { nextTick, onBeforeUnmount, ref, type Ref } from 'vue';

interface AnchoredMenuEl {
  el?: HTMLElement | null;
}

const GAP = 4;
const VIEWPORT_MARGIN = 8;

export function useAnchoredMenu(menuRef: Ref<AnchoredMenuEl | null | undefined>, additionalMenuRef?: Ref<AnchoredMenuEl | null | undefined>) {
  const open = ref(false);
  const menuStyle = ref<Record<string, string>>({});
  let trigger: HTMLElement | null = null;

  function removeListeners(): void {
    document.removeEventListener('mousedown', onDocMouseDown);
    document.removeEventListener('keydown', onDocKeyDown);
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
  }

  function addListeners(): void {
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
  }

  function close(): void {
    if (!open.value) return;
    open.value = false;
    trigger = null;
    removeListeners();
  }

  function onDocMouseDown(e: MouseEvent): void {
    const target = e.target as Node;
    if (menuRef.value?.el?.contains(target) === true) return;
    if (additionalMenuRef?.value?.el?.contains(target) === true) return;
    if (trigger !== null && trigger.contains(target)) return;
    close();
  }

  function onDocKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }

  async function place(
    x: number,
    y: number,
    opts?: { flipAboveGap?: number; alignRightTo?: number },
  ): Promise<void> {
    if (!open.value) {
      open.value = true;
      addListeners();
    }
    await nextTick();
    const menu = menuRef.value?.el;
    const menuH = menu?.offsetHeight ?? 0;
    const menuW = menu?.offsetWidth ?? 0;
    let top = y;
    let flipped = false;
    if (top + menuH > window.innerHeight - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, y - menuH - (opts?.flipAboveGap ?? 0));
      flipped = true;
    }
    let left = opts?.alignRightTo !== undefined ? opts.alignRightTo - menuW : x;
    if (left + menuW > window.innerWidth - VIEWPORT_MARGIN) {
      left = Math.max(VIEWPORT_MARGIN, window.innerWidth - menuW - VIEWPORT_MARGIN);
    }
    if (left < VIEWPORT_MARGIN) {
      left = VIEWPORT_MARGIN;
    }
    const originX = opts?.alignRightTo !== undefined ? 'right' : 'left';
    menuStyle.value = {
      top: `${Math.round(top)}px`,
      left: `${Math.round(left)}px`,
      transformOrigin: flipped ? `bottom ${originX}` : `top ${originX}`,
      '--menu-pop-shift': flipped ? '2px' : '-2px',
    };
  }

  async function show(e: MouseEvent): Promise<void> {
    trigger = e.currentTarget as HTMLElement;
    const r = trigger.getBoundingClientRect();
    await place(r.left, r.bottom + GAP, { flipAboveGap: r.height + GAP * 2 });
  }

  async function showAnchored(e: MouseEvent, align: 'left' | 'right'): Promise<void> {
    trigger = e.currentTarget as HTMLElement;
    const r = trigger.getBoundingClientRect();
    await place(r.left, r.bottom + GAP, {
      flipAboveGap: r.height + GAP * 2,
      alignRightTo: align === 'right' ? r.right : undefined,
    });
  }

  async function toggle(e: MouseEvent): Promise<void> {
    if (open.value) {
      close();
      return;
    }
    await show(e);
  }

  async function toggleAnchored(e: MouseEvent, align: 'left' | 'right'): Promise<void> {
    if (open.value) {
      close();
      return;
    }
    await showAnchored(e, align);
  }

  async function openAt(x: number, y: number): Promise<void> {
    trigger = null;
    await place(x, y);
  }

  onBeforeUnmount(removeListeners);

  return { open, menuStyle, show, showAnchored, toggle, toggleAnchored, openAt, close, place };
}
