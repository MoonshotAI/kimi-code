import { getCurrentInstance, nextTick, provide, ref, type InjectionKey, type Ref } from 'vue';

export interface SettingsSubpageHost {
  fit: () => void;
  release: () => void;
  header: () => HTMLElement | null;
}

export const SettingsSubpageHostKey: InjectionKey<SettingsSubpageHost> = Symbol('SettingsSubpageHost');

export interface SettingsSubpage<T> {
  page: Ref<T | null>;
  fitHeight: Ref<number | null>;
  open: (id: T, origin?: EventTarget | null) => void;
  back: () => void;
  reset: () => void;
}

const SETTLE_FRAMES = 3;
const MAX_SETTLE_FRAMES = 30;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

async function settledScrollHeight(el: HTMLElement, alive: () => boolean): Promise<number> {
  let last = -1;
  let stable = 0;
  for (let frame = 0; frame < MAX_SETTLE_FRAMES && alive(); frame++) {
    await nextFrame();
    const height = el.scrollHeight;
    stable = height === last ? stable + 1 : 0;
    last = height;
    if (stable >= SETTLE_FRAMES) break;
  }
  return last;
}

export function useSettingsSubpage<T>(scroller?: () => HTMLElement | null | undefined): SettingsSubpage<T> {
  const page = ref<T | null>(null) as Ref<T | null>;
  const fitHeight = ref<number | null>(null);
  let fitToken = 0;

  async function fit(): Promise<void> {
    const token = ++fitToken;
    const alive = () => token === fitToken && page.value !== null;
    const el = scroller?.();
    const dialog = el?.closest<HTMLElement>('.ui-dialog');
    if (!el || !dialog) return;
    await document.fonts?.ready;
    const scrollHeight = await settledScrollHeight(el, alive);
    if (!alive()) return;
    const overflow = scrollHeight - el.clientHeight;
    if (overflow <= 0) return;
    const current = dialog.getBoundingClientRect().height;
    const cap = Number.parseFloat(getComputedStyle(dialog).maxHeight);
    const target = Math.ceil(current + overflow);
    fitHeight.value = Number.isFinite(cap) ? Math.min(target, Math.floor(cap)) : target;
  }

  function release(): void {
    fitToken++;
    fitHeight.value = null;
  }

  if (getCurrentInstance()) {
    provide(SettingsSubpageHostKey, {
      fit: () => void fit(),
      release,
      header: () => scroller?.()?.closest('.settings-region')?.querySelector<HTMLElement>('.settings-region-header') ?? null,
    });
  }
  let origin: HTMLElement | null = null;
  let scrollTop = 0;

  function open(id: T, from?: EventTarget | null): void {
    origin = from instanceof HTMLElement ? from : null;
    scrollTop = scroller?.()?.scrollTop ?? 0;
    page.value = id;
    void nextTick(() => {
      const el = scroller?.();
      if (el) el.scrollTop = 0;
    });
  }

  function back(): void {
    const id = page.value;
    if (id === null) return;
    page.value = null;
    release();
    const returnTo = origin;
    origin = null;
    void nextTick(() => {
      const el = scroller?.();
      if (el) el.scrollTop = scrollTop;
      const target = returnTo?.isConnected
        ? returnTo
        : [...document.querySelectorAll<HTMLElement>('[data-settings-subpage-origin]')].find(
            (el) => el.dataset.settingsSubpageOrigin === String(id),
          );
      target?.focus({ preventScroll: true });
    });
  }

  function reset(): void {
    page.value = null;
    release();
    origin = null;
  }

  return { page, fitHeight, open, back, reset };
}
