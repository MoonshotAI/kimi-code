import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';

export const openMenuCount = ref(0);

export const anyMenuOpen = computed(() => openMenuCount.value > 0);

export interface MenuSurfaceElement {
  contains(other: MenuSurfaceElement | null): boolean;
}

const surfaces = new Set<MenuSurfaceElement>();

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

export function registerExternalMenuSurface(): () => void {
  openMenuCount.value += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openMenuCount.value = Math.max(0, openMenuCount.value - 1);
  };
}

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
