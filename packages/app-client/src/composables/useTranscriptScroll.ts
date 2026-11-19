import { nextTick, onMounted, onUnmounted, provide, ref, shallowRef, watch, type Ref } from 'vue';
import { TranscriptScrollKey, type TranscriptListHandle, type TranscriptScrollHost } from '@moonshot-ai/app-core/contracts';
import {
  createDomScrollAdapter,
  createScrollController,
  LayoutModel,
  type AnchorPath,
  type AuxKind,
  type NavigateOptions,
  type ScrollAdapter,
  type ScrollController,
  type ScrollOptions,
  type ScrollSnapshot,
  type ScrollState,
  type TranscriptLayout,
} from '@moonshot-ai/app-core/lib';
import { PinScrollKey } from '../contracts';

export const TRANSCRIPT_DOCK_FADE_PX = 48;
const SCROLLING_CLASS_MS = 900;
const SNAPSHOT_LIMIT = 50;

export interface TranscriptScrollOptions {
  sessionId: () => string | undefined;
  touch?: () => boolean;
  dockFadePx?: number;
  controller?: Partial<ScrollOptions>;
}

export interface TranscriptScroll {
  host: TranscriptScrollHost;
  scroller: Readonly<Ref<HTMLElement | null>>;
  dock: Readonly<Ref<HTMLElement | null>>;
  following: Readonly<Ref<boolean>>;
  showJump: Readonly<Ref<boolean>>;
  activeRowKey: Readonly<Ref<string | null>>;
  scrolling: Readonly<Ref<boolean>>;
  dockHeight: Readonly<Ref<number>>;
  scrollbarWidth: Readonly<Ref<number>>;
  bindScroller: (el: HTMLElement | null) => void;
  bindDock: (el: HTMLElement | null) => void;
  onScroll: () => void;
  onInput: (event: Event) => void;
  follow: (options?: { smooth?: boolean }) => void;
  navigateToTurn: (id: string) => Promise<void>;
  revealRange: (range: Range) => void;
}

type AuxEntry = { kind: AuxKind; el: HTMLElement; id?: string };

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scrollNestedContainersToRange(range: Range, pane: HTMLElement): void {
  const parent = range.startContainer.parentElement;
  if (parent === null) return;
  for (let node: Element | null = parent; node !== null && node !== pane; node = node.parentElement) {
    const style = getComputedStyle(node);
    const canScrollY = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
    const canScrollX = /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
    if (!canScrollY && !canScrollX) continue;
    const rect = range.getClientRects()[0];
    if (!rect) return;
    const nodeRect = node.getBoundingClientRect();
    if (canScrollY) node.scrollTop += (rect.top + rect.height / 2) - (nodeRect.top + node.clientHeight / 2);
    if (canScrollX) node.scrollLeft += (rect.left + rect.width / 2) - (nodeRect.left + node.clientWidth / 2);
  }
}

export function useTranscriptScroll(options: TranscriptScrollOptions): TranscriptScroll {
  const dockFadePx = options.dockFadePx ?? TRANSCRIPT_DOCK_FADE_PX;
  const scroller = ref<HTMLElement | null>(null);
  const dock = ref<HTMLElement | null>(null);
  const controller = shallowRef<ScrollController | null>(null);
  const model = new LayoutModel({ scope: options.sessionId() ?? '' });
  const following = ref(true);
  const showJump = ref(false);
  const activeRowKey = ref<string | null>(null);
  const scrolling = ref(false);
  const dockHeight = ref(0);
  const scrollbarWidth = ref(0);
  const rows = new Map<string, HTMLElement>();
  const aux = new Map<string, AuxEntry>();
  const snapshots = new Map<string, ScrollSnapshot>();
  let adapter: ScrollAdapter | null = null;
  let list: TranscriptListHandle | null = null;
  let inLayout = false;
  let quiet = false;
  let syncQueued = false;
  let scrollingTimer: ReturnType<typeof setTimeout> | null = null;
  let publishFrame = 0;
  const published = { following: true, showJump: false, activeRowKey: null as string | null, dockHeight: 0, scrollbarWidth: 0 };

  function publish(): void {
    if (publishFrame) {
      cancelAnimationFrame(publishFrame);
      publishFrame = 0;
    }
    following.value = published.following;
    showJump.value = published.showJump;
    activeRowKey.value = published.activeRowKey;
    dockHeight.value = published.dockHeight;
    scrollbarWidth.value = published.scrollbarWidth;
  }

  function schedulePublish(): void {
    if (!inLayout) {
      publish();
      return;
    }
    if (!publishFrame) {
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
    const el = scroller.value;
    if (layout.dockHeight !== published.dockHeight) {
      published.dockHeight = layout.dockHeight;
      const wrap = el?.firstElementChild;
      if (wrap instanceof HTMLElement) wrap.style.paddingBottom = `${layout.dockHeight + dockFadePx}px`;
      schedulePublish();
    }
    if (el) {
      const width = Math.max(0, el.offsetWidth - el.clientWidth);
      if (width !== published.scrollbarWidth) {
        published.scrollbarWidth = width;
        schedulePublish();
      }
    }
    list?.applyLayout();
  }

  function onChange(state: Readonly<ScrollState>): void {
    published.following = state.following;
    published.showJump = state.showJump;
    published.activeRowKey = state.activeRowKey;
    schedulePublish();
    if (!quiet) list?.refresh('scroll', inLayout);
  }

  function connect(el: HTMLElement | null): void {
    controller.value?.dispose();
    controller.value = null;
    adapter = null;
    if (!el) return;
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    if (fonts?.status === 'loading') {
      void fonts.ready.then(() => {
        if (scroller.value === el && controller.value === null) connect(el);
      });
      return;
    }
    adapter = createDomScrollAdapter({ scroller: el, model, list: () => list?.root ?? null, applyLayout });
    const next = createScrollController(adapter, { ...options.controller, onChange });
    controller.value = next;
    for (const [key, row] of rows) next.observeRow(key, row);
    for (const entry of aux.values()) next.observeAux(entry.kind, entry.el, entry.id);
    if (dock.value) next.observeAux('dock', dock.value);
    onChange(next.state);
  }

  function sync(): void {
    controller.value?.sync();
  }

  function queueSync(): void {
    if (syncQueued) return;
    syncQueued = true;
    void nextTick(() => {
      syncQueued = false;
      sync();
    });
  }

  const host: TranscriptScrollHost = {
    model,
    scroller,
    controller,
    touch: () => options.touch?.() === true,
    attachList(handle) {
      list = handle;
      return () => {
        if (list !== handle) return;
        list = null;
        host.observeAux('content', null);
      };
    },
    observeRow(key, el) {
      if (el) rows.set(key, el);
      else rows.delete(key);
      controller.value?.observeRow(key, el);
    },
    observeAux(kind, el, id) {
      const slot = id === undefined ? kind : `${kind}:${id}`;
      const previous = aux.get(slot);
      if (previous?.el === el || (!previous && !el)) return;
      if (el) aux.set(slot, { kind, el, id });
      else aux.delete(slot);
      controller.value?.observeAux(kind, el, id);
      if (!el && kind !== 'content') queueSync();
    },
    resolveAnchor(path: AnchorPath) {
      return adapter?.resolveAnchor(path) ?? null;
    },
    navigate(path: AnchorPath, navigateOptions?: NavigateOptions) {
      return controller.value?.navigate(path, navigateOptions) ?? Promise.resolve();
    },
    sync,
  };

  provide(TranscriptScrollKey, host);
  provide(PinScrollKey, (el: HTMLElement, ms?: number) => controller.value?.hold(el, ms));

  function onInput(event: Event): void {
    controller.value?.onInput(event);
  }

  function bindScroller(el: HTMLElement | null): void {
    if (el === scroller.value) return;
    const previous = scroller.value;
    if (previous) {
      previous.removeEventListener('touchend', onInput);
      previous.removeEventListener('touchcancel', onInput);
      previous.removeEventListener('scrollend', onInput);
    }
    scroller.value = el;
    if (el) {
      el.addEventListener('touchend', onInput, { passive: true });
      el.addEventListener('touchcancel', onInput, { passive: true });
      el.addEventListener('scrollend', onInput, { passive: true });
    }
    connect(el);
  }

  function bindDock(el: HTMLElement | null): void {
    if (el === dock.value) return;
    dock.value = el;
    controller.value?.observeAux('dock', el);
  }

  function onScroll(): void {
    scrolling.value = true;
    if (scrollingTimer) clearTimeout(scrollingTimer);
    scrollingTimer = setTimeout(() => {
      scrolling.value = false;
      scrollingTimer = null;
    }, SCROLLING_CLASS_MS);
    const current = controller.value;
    if (!current) return;
    quiet = true;
    try {
      current.onScroll();
    } finally {
      quiet = false;
    }
    list?.refresh('scroll');
  }

  function follow(followOptions?: { smooth?: boolean }): void {
    controller.value?.follow(followOptions);
  }

  async function navigateToTurn(id: string): Promise<void> {
    await controller.value?.navigate({ row: id }, { align: 'center', smooth: !prefersReducedMotion() });
  }

  function revealRange(range: Range): void {
    const pane = scroller.value;
    const current = controller.value;
    if (!pane || !current || !adapter) return;
    scrollNestedContainersToRange(range, pane);
    const start = range.startContainer;
    const owner = start instanceof Element ? start : start.parentElement;
    if (!owner) return;
    const path = adapter.pathOf(owner);
    const target = path ? adapter.resolveAnchor(path) : null;
    if (!path || !target) return;
    const rect = range.getClientRects()[0] ?? owner.getBoundingClientRect();
    const shift = rect.top + rect.height / 2 - target.getBoundingClientRect().top - pane.clientHeight / 2;
    void current.navigate(path, { align: 'start', shift, smooth: !prefersReducedMotion() });
  }

  function remember(key: string, snapshot: ScrollSnapshot): void {
    snapshots.delete(key);
    snapshots.set(key, snapshot);
    while (snapshots.size > SNAPSHOT_LIMIT) snapshots.delete(snapshots.keys().next().value!);
  }

  watch(options.sessionId, (next, previous) => {
    const current = controller.value;
    if (!current) return;
    if (previous) remember(previous, current.snapshot());
    current.restore(next ? snapshots.get(next) ?? null : null, { defer: true });
  });

  onMounted(() => {
    document.addEventListener('pointerup', onInput, true);
    document.addEventListener('pointercancel', onInput, true);
  });

  onUnmounted(() => {
    document.removeEventListener('pointerup', onInput, true);
    document.removeEventListener('pointercancel', onInput, true);
    if (scrollingTimer) clearTimeout(scrollingTimer);
    if (publishFrame) cancelAnimationFrame(publishFrame);
    bindScroller(null);
  });

  return {
    host,
    scroller,
    dock,
    following,
    showJump,
    activeRowKey,
    scrolling,
    dockHeight,
    scrollbarWidth,
    bindScroller,
    bindDock,
    onScroll,
    onInput,
    follow,
    navigateToTurn,
    revealRange,
  };
}
