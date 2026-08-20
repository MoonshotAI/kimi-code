import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';

/**
 * Registry of the menu surfaces currently open — the design-system `Menu`
 * primitive registers on mount (it is rendered with v-if only while open),
 * the `Select` listbox and app-side bespoke menus (composer popups, pickers)
 * register through `trackMenuSurface` while their open ref is true.
 *
 * TooltipBubble reads this to match the native menu behavior: while any menu
 * is open, every tooltip OUTSIDE the open surfaces hides immediately and no
 * new one may appear; tooltips anchored INSIDE an open menu surface stay
 * live. Once the last menu closes, ordinary hover behavior resumes.
 */

/** Number of menu surfaces currently open (mirrors `openDialogCount`). */
export const openMenuCount = ref(0);

/** True while at least one menu surface is open. */
export const anyMenuOpen = computed(() => openMenuCount.value > 0);

/**
 * The slice of the DOM the registry needs. Structural (not `HTMLElement`) so
 * this module stays DOM-free like the package's other pure ts modules
 * (lib/selectMenu) — the base tsconfig has no DOM lib.
 */
export interface MenuSurfaceElement {
  contains(other: MenuSurfaceElement | null): boolean;
}

/** Elements of the currently open surfaces, for the inside/outside check. */
const surfaces = new Set<MenuSurfaceElement>();

/**
 * Register one open menu surface element. Returns the release function —
 * call it when the surface closes or unmounts. The release is idempotent.
 */
export function registerMenuSurface(el: MenuSurfaceElement): () => void {
  surfaces.add(el);
  openMenuCount.value += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (surfaces.delete(el)) openMenuCount.value -= 1;
  };
}

/** True when `el` sits inside one of the currently open menu surfaces. */
export function isInOpenMenuSurface(el: MenuSurfaceElement | null): boolean {
  if (!el) return false;
  for (const surface of surfaces) {
    if (surface === el || surface.contains(el)) return true;
  }
  return false;
}

function isMenuSurfaceElement(value: unknown): value is MenuSurfaceElement {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { contains?: unknown }).contains === 'function'
  );
}

/**
 * Keep a bespoke menu surface registered while `open` is true. For menus
 * that cannot be the `Menu` primitive (composer dropdowns, custom pickers):
 * pass the open ref and the panel element ref. The post-flush watch sees the
 * panel right after the open render (it usually mounts with v-if), and the
 * registration releases on close and on scope dispose.
 */
export function trackMenuSurface(open: Ref<boolean>, el: Readonly<Ref<unknown>>): void {
  let release: (() => void) | undefined;
  watch(
    [open, el],
    ([isOpen, panel]) => {
      release?.();
      release = undefined;
      if (isOpen && isMenuSurfaceElement(panel)) release = registerMenuSurface(panel);
    },
    { flush: 'post', immediate: true },
  );
  onScopeDispose(() => {
    release?.();
    release = undefined;
  });
}
