import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { trackMenuSurface } from '@moonshot-ai/app-ui';

export interface CreatePopover {
  open: Ref<boolean>;
  up: Ref<boolean>;
  maxHeight: Ref<number | null>;
  toggle: () => void;
  close: (options?: { focusTrigger?: boolean }) => void;
}

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 4;

export function useCreatePopover(
  anchor: Readonly<Ref<HTMLElement | null>>,
  panel: Readonly<Ref<HTMLElement | null>>,
  trigger: Readonly<Ref<HTMLElement | null>>,
): CreatePopover {
  const open = ref(false);
  const up = ref(false);
  const maxHeight = ref<number | null>(null);
  trackMenuSurface(open, panel);

  function place(): void {
    const el = anchor.value;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const port = el.closest('.panes')?.getBoundingClientRect();
    const top = port?.top ?? 0;
    const bottom = port?.bottom ?? window.innerHeight;
    const below = bottom - rect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
    const above = rect.top - top - ANCHOR_GAP - VIEWPORT_MARGIN;
    up.value = below < 200 && above > below;
    const available = Math.floor(up.value ? above : below);
    maxHeight.value = available > 0 ? available : null;
  }

  function onPointerDown(event: MouseEvent): void {
    const target = event.target as Node | null;
    if (target === null) return;
    if (anchor.value?.contains(target)) return;
    close();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    close({ focusTrigger: true });
  }

  function listen(active: boolean): void {
    if (typeof document === 'undefined') return;
    document.removeEventListener('mousedown', onPointerDown, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', place);
    if (!active) return;
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', place);
  }

  watch(open, (isOpen) => listen(isOpen));
  onScopeDispose(() => listen(false));

  function toggle(): void {
    if (open.value) {
      close();
      return;
    }
    place();
    open.value = true;
  }

  function close(options?: { focusTrigger?: boolean }): void {
    if (!open.value) return;
    open.value = false;
    if (options?.focusTrigger === true) trigger.value?.focus();
  }

  return { open, up, maxHeight, toggle, close };
}
