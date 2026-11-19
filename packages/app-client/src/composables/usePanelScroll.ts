import { nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, onUnmounted, ref, watch, type Ref } from 'vue';
import {
  createDomScrollAdapter,
  createScrollController,
  LayoutModel,
  type ScrollController,
  type ScrollOptions,
  type ScrollSnapshot,
  type ScrollState,
  type TranscriptLayout,
} from '@moonshot-ai/app-core/lib';

const SNAPSHOT_LIMIT = 50;
const INPUT_EVENTS = ['wheel', 'pointerdown', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'keydown', 'scrollend'] as const;

export interface PanelScrollOptions {
  identity: () => string | null | undefined;
  snapshots?: Map<string, ScrollSnapshot>;
  applyLayout?: (layout: TranscriptLayout) => void;
  controller?: Partial<ScrollOptions>;
}

export interface PanelScroll {
  scroller: Ref<HTMLElement | null>;
  dock: Ref<HTMLElement | null>;
  following: Readonly<Ref<boolean>>;
  showJump: Readonly<Ref<boolean>>;
  onScroll: () => void;
  onInput: (event: Event) => void;
  follow: (options?: { smooth?: boolean }) => void;
  hold: (el: HTMLElement) => void;
}

export function usePanelScroll(options: PanelScrollOptions): PanelScroll {
  const scroller = ref<HTMLElement | null>(null);
  const dock = ref<HTMLElement | null>(null);
  const following = ref(true);
  const showJump = ref(false);
  const model = new LayoutModel({ scope: 'panel' });
  const snapshots = options.snapshots ?? new Map<string, ScrollSnapshot>();
  const published = { following: true, showJump: false };
  let controller: ScrollController | null = null;
  let bound: HTMLElement | null = null;
  let content: Element | null = null;
  let mutations: MutationObserver | null = null;
  let identity = options.identity() ?? null;
  let parked: ScrollSnapshot | null = identity === null ? null : snapshots.get(identity) ?? null;
  let deactivated = false;
  let inLayout = false;
  let publishFrame = 0;

  function publish(): void {
    if (publishFrame) {
      cancelAnimationFrame(publishFrame);
      publishFrame = 0;
    }
    following.value = published.following;
    showJump.value = published.showJump;
  }

  function onChange(state: Readonly<ScrollState>): void {
    published.following = state.following;
    published.showJump = state.showJump;
    if (controller && bound?.isConnected) parked = controller.snapshot();
    if (!inLayout) publish();
    else if (!publishFrame) {
      publishFrame = requestAnimationFrame(() => {
        publishFrame = 0;
        publish();
      });
    }
  }

  function applyLayout(layout: TranscriptLayout): void {
    inLayout = true;
    queueMicrotask(() => {
      inLayout = false;
    });
    options.applyLayout?.(layout);
  }

  function onInput(event: Event): void {
    controller?.onInput(event);
  }

  function observeContent(): void {
    const next = bound?.firstElementChild ?? null;
    if (next === content) return;
    content = next;
    controller?.observeAux('content', next instanceof HTMLElement ? next : null);
  }

  function unbind(): void {
    controller?.dispose();
    controller = null;
    mutations?.disconnect();
    mutations = null;
    content = null;
    if (!bound) return;
    for (const type of INPUT_EVENTS) bound.removeEventListener(type, onInput);
    bound.style.overflowAnchor = '';
    bound = null;
  }

  function connect(): void {
    unbind();
    const el = deactivated ? null : scroller.value;
    if (!el) return;
    bound = el;
    el.style.overflowAnchor = 'none';
    for (const type of INPUT_EVENTS) el.addEventListener(type, onInput, { passive: true });
    const adapter = createDomScrollAdapter({ scroller: el, model, list: () => null, applyLayout });
    controller = createScrollController(adapter, { ...options.controller, onChange });
    if (dock.value) controller.observeAux('dock', dock.value);
    observeContent();
    if (typeof MutationObserver === 'function') {
      mutations = new MutationObserver(observeContent);
      mutations.observe(el, { childList: true });
    }
    controller.restore(parked);
  }

  function live(): ScrollSnapshot | null {
    return controller && bound?.isConnected ? controller.snapshot() : parked;
  }

  function remember(key: string, snapshot: ScrollSnapshot | null): void {
    snapshots.delete(key);
    if (!snapshot) return;
    snapshots.set(key, snapshot);
    while (snapshots.size > SNAPSHOT_LIMIT) snapshots.delete(snapshots.keys().next().value!);
  }

  watch(scroller, connect, { flush: 'sync' });
  watch(dock, (el) => controller?.observeAux('dock', el), { flush: 'sync' });
  watch(() => options.identity() ?? null, (next) => {
    if (next === identity) return;
    if (identity !== null) remember(identity, live());
    identity = next;
    parked = next === null ? null : snapshots.get(next) ?? null;
    void nextTick(() => {
      if (identity === next) controller?.restore(parked);
    });
  });

  onMounted(() => {
    document.addEventListener('pointerup', onInput, true);
    document.addEventListener('pointercancel', onInput, true);
  });

  onDeactivated(() => {
    deactivated = true;
    unbind();
  });

  onActivated(() => {
    if (!deactivated) return;
    deactivated = false;
    connect();
  });

  onBeforeUnmount(() => {
    if (identity !== null) remember(identity, live());
  });

  onUnmounted(() => {
    document.removeEventListener('pointerup', onInput, true);
    document.removeEventListener('pointercancel', onInput, true);
    if (publishFrame) cancelAnimationFrame(publishFrame);
    unbind();
  });

  function onScroll(): void {
    controller?.onScroll();
  }

  function follow(followOptions?: { smooth?: boolean }): void {
    controller?.follow(followOptions);
  }

  function hold(el: HTMLElement): void {
    controller?.hold(el);
  }

  return { scroller, dock, following, showJump, onScroll, onInput, follow, hold };
}
