// apps/web/src/components/admin/useAnchoredMenu.ts
// Anchored-dropdown mechanics shared by the admin page's menus (FilterSelect /
// MultiSelectMenu / SessionAdminMenu): a fixed-position Menu, flipping up when
// the bottom edge wouldn't fit, clamped to the viewport. Closed by outside
// mousedown / Esc / scroll / resize — same behavior as the Sidebar view menu,
// which this mirrors; a scroll INSIDE the menu is the one exception (the
// multi-select's options area scrolls itself, see onScrollCapture). Three anchor modes:
//   toggle(e)                 left-aligned under the trigger (filter selects)
//   toggleAnchored(e, align)  trigger-anchored, left or right edge (row ⋯)
//   openAt(x, y)              raw viewport point (row contextmenu)

import { nextTick, onBeforeUnmount, ref, type Ref } from 'vue';

interface AnchoredMenuEl {
  el?: HTMLElement | null;
}

const GAP = 4;
const VIEWPORT_MARGIN = 8;

export function useAnchoredMenu(menuRef: Ref<AnchoredMenuEl | null | undefined>) {
  const open = ref(false);
  const menuStyle = ref<Record<string, string>>({});
  let trigger: HTMLElement | null = null;

  function removeListeners(): void {
    document.removeEventListener('mousedown', onDocMouseDown);
    document.removeEventListener('keydown', onDocKeyDown);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', onScrollCapture, true);
  }

  function addListeners(): void {
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onDocKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScrollCapture, true);
  }

  function close(): void {
    if (!open.value) return;
    open.value = false;
    trigger = null;
    removeListeners();
  }

  function onDocMouseDown(e: MouseEvent): void {
    const target = e.target as Element;
    if (target.closest('.sa-menu') || (trigger !== null && trigger.contains(target))) return;
    close();
  }

  function onDocKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }

  /** Scroll closes the menu — EXCEPT scrolls inside the menu itself (the
   *  multi-select's options area has its own capped-height scroll). Scroll
   *  doesn't bubble, but this window-level capture listener still sees
   *  descendant scrolls, so filter by target. */
  function onScrollCapture(e: Event): void {
    if (e.target instanceof Element && e.target.closest('.sa-menu')) return;
    close();
  }

  /** Open (or re-position an already-open menu) at a raw point. The menu pops
   *  out toward the bottom-right of the anchor, flipping up / clamping left
   *  at the viewport edges. `alignRightTo` right-aligns the menu to that
   *  viewport x instead of left-aligning it to `x` (row ⋯ trigger). */
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
    // The pop animation grows out of the anchor corner — the origin and the
    // nudge direction follow the upward flip (Sidebar view-menu pattern).
    menuStyle.value = {
      top: `${Math.round(top)}px`,
      left: `${Math.round(left)}px`,
      transformOrigin: flipped ? 'bottom left' : 'top left',
      '--menu-pop-shift': flipped ? '2px' : '-2px',
    };
  }

  /** Left-aligned dropdown under the trigger (filter selects). */
  async function toggle(e: MouseEvent): Promise<void> {
    if (open.value) {
      close();
      return;
    }
    trigger = e.currentTarget as HTMLElement;
    const r = trigger.getBoundingClientRect();
    await place(r.left, r.bottom + GAP, { flipAboveGap: r.height + GAP * 2 });
  }

  /** Trigger-anchored dropdown aligned to the trigger's left or right edge
   *  (right edge: the row ⋯ button — the menu hangs under it, flush right). */
  async function toggleAnchored(e: MouseEvent, align: 'left' | 'right'): Promise<void> {
    if (open.value) {
      close();
      return;
    }
    trigger = e.currentTarget as HTMLElement;
    const r = trigger.getBoundingClientRect();
    await place(r.left, r.bottom + GAP, {
      flipAboveGap: r.height + GAP * 2,
      alignRightTo: align === 'right' ? r.right : undefined,
    });
  }

  /** Context menu at a raw viewport point (right-click). Re-positioning while
   *  already open is fine — a second right-click moves the menu. */
  async function openAt(x: number, y: number): Promise<void> {
    trigger = null;
    await place(x, y);
  }

  onBeforeUnmount(removeListeners);

  return { open, menuStyle, toggle, toggleAnchored, openAt, close };
}
