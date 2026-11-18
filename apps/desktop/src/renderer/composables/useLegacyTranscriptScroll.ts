import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch, type ComponentPublicInstance, type Ref } from 'vue';
import { HistoryScrollKey } from '@moonshot-ai/app-core/contracts';
import { isEditableTarget, nestedScrollerTakesUpwardScroll, nextJumpPillVisible, scrollKeyDirection } from '@moonshot-ai/app-core/lib';
import { PinScrollKey } from '@moonshot-ai/app-client/contracts';
import type { ChatTurn } from '../types';

export interface TranscriptScrollBinding {
  panesRef: Readonly<Ref<HTMLElement | null>>;
  dockRef: Readonly<Ref<HTMLElement | null>>;
  bindChatPane: (el: Element | ComponentPublicInstance | null) => void;
  bindDock: (el: HTMLElement | null) => void;
  following: Readonly<Ref<boolean>>;
  showPill: Readonly<Ref<boolean>>;
  panesScrolling: Readonly<Ref<boolean>>;
  sessionSettling: Readonly<Ref<boolean>>;
  dockHeight: Readonly<Ref<number>>;
  contentWrapStyle: Readonly<Ref<{ paddingBottom: string }>>;
  chatDockStyle: Readonly<Ref<Record<string, string>>>;
  activeTurnId: Readonly<Ref<string | null>>;
  onPanesScroll: () => void;
  onPanesWheel: (event: WheelEvent) => void;
  onPanesPointerDown: (event: PointerEvent) => void;
  onPanesTouchStart: (event: TouchEvent) => void;
  onPanesTouchMove: (event: TouchEvent) => void;
  onTranscriptKeyDown: (event: KeyboardEvent) => void;
  scrollToBottom: (smooth?: boolean) => void;
  scrollToTurn: (turnId: string) => Promise<void>;
  revealTranscriptRange: (range: Range) => void;
  followAfterUserAction: () => void;
  lockFollowForUserAction: () => void;
  handleLoadOlderMessages: () => Promise<void>;
}

export interface LegacyTranscriptScrollOptions {
  sessionId: () => string | undefined;
  mobile: () => boolean | undefined;
  turns: Readonly<Ref<readonly ChatTurn[]>>;
  approvals: Readonly<Ref<readonly { approvalId: string }[]>>;
  sessionLoading: Readonly<Ref<boolean>>;
  hasMoreMessages: Readonly<Ref<boolean>>;
  loadingMore: Readonly<Ref<boolean>>;
  turnActive: Readonly<Ref<boolean>>;
  conversationTocItems: Readonly<Ref<readonly { id: string }[]>>;
  chatPaneRef: Readonly<Ref<{ revealTurn: (id: string) => Promise<unknown> } | null>>;
  loadOlderMessages: (sessionId: string) => Promise<unknown>;
  syncWideTableToc: () => void;
  keyScrollBlocked: (event: KeyboardEvent) => boolean;
}

export function toHtmlEl(el: Element | ComponentPublicInstance | null): HTMLElement | null {
  if (el instanceof HTMLElement) return el;
  if (el && '$el' in el && el.$el instanceof HTMLElement) return el.$el;
  return null;
}

export function useLegacyTranscriptScroll(options: LegacyTranscriptScrollOptions): TranscriptScrollBinding {
  const {
    sessionId,
    mobile,
    turns,
    approvals,
    sessionLoading,
    hasMoreMessages,
    loadingMore,
    turnActive,
    conversationTocItems,
    chatPaneRef,
    loadOlderMessages,
    syncWideTableToc,
    keyScrollBlocked,
  } = options;

  provide(PinScrollKey, pinScrollFor);
  const pendingHistoryScrolls = new Map<HTMLElement, { top: number }>();
  provide(HistoryScrollKey, (container, delta) => {
    if (!delta || (container === panesRef.value && following.value)) return;
    const existing = pendingHistoryScrolls.get(container);
    if (existing) { existing.top += delta; return; }
    const pending = { top: container.scrollTop + delta };
    pendingHistoryScrolls.set(container, pending);
    void nextTick(() => {
      if (pendingHistoryScrolls.get(container) !== pending) return;
      pendingHistoryScrolls.delete(container);
      if (!container.isConnected || (container === panesRef.value && following.value)) return;
      container.scrollTop = pending.top;
      if (container === panesRef.value) lastScrollTop = container.scrollTop;
    });
  });

  const activeTurnId = ref<string | null>(null);
  const turnQuestionIds = computed(() => {
    const result = new Map<string, string>();
    let questionId: string | null = null;
    for (const turn of turns.value) {
      if (turn.role === 'user') questionId = turn.id;
      if (questionId !== null) result.set(turn.id, questionId);
    }
    return result;
  });

  function updateActiveTocQuery(): void {
    const pane = panesRef.value;
    if (!pane) return;
    const items = conversationTocItems.value;
    if (items.length === 0) return;

    if (distanceFromBottom() <= BOTTOM_THRESHOLD) {
      activeTurnId.value = items[items.length - 1]!.id;
      return;
    }

    if (tocAnchorsDirty || tocAnchorsCache === null) {
      const scrollTop = pane.scrollTop;
      const paneTop = pane.getBoundingClientRect().top;
      const measured: { id: string; top: number }[] = [];
      for (const el of pane.querySelectorAll<HTMLElement>('.turn-anchor[data-turn-id]')) {
        const id = el.dataset.turnId;
        if (id) measured.push({ id, top: el.getBoundingClientRect().top - paneTop + scrollTop });
      }
      tocAnchorsCache = measured;
      tocAnchorsDirty = false;
    }
    const paneMiddle = pane.scrollTop + pane.clientHeight / 2;
    let bestId: string | null = null;
    for (const anchor of tocAnchorsCache) {
      const questionId = turnQuestionIds.value.get(anchor.id);
      if (questionId && anchor.top <= paneMiddle) bestId = questionId;
    }
    activeTurnId.value = bestId ?? items[0]!.id;
  }

  let tocAnchorsCache: { id: string; top: number }[] | null = null;
  let tocAnchorsDirty = true;

  function markTocAnchorsDirty(): void {
    tocAnchorsDirty = true;
  }

  let activeTocRaf = 0;

  function scheduleActiveTocUpdate(): void {
    if (activeTocRaf) return;
    activeTocRaf = raf(() => {
      activeTocRaf = 0;
      updateActiveTocQuery();
    });
  }

  function onTableLayout(): void {
    syncWideTableToc();
    markTocAnchorsDirty();
  }

  const panesRef = ref<HTMLElement | null>(null);
  const dockRef = ref<HTMLElement | null>(null);
  const panesScrollbarWidth = ref(0);
  const dockHeight = ref(0);

  const chatDockStyle = computed(() => ({
    '--panes-scrollbar-width': `${panesScrollbarWidth.value}px`,
  }));
  const DOCK_VEIL_FADE_PX = 48;
  const contentWrapStyle = computed(() => ({
    paddingBottom: `${dockHeight.value + DOCK_VEIL_FADE_PX}px`,
  }));

  let panesGeomRaf = 0;

  function updateDockHeight(): void {
    const dh = dockRef.value?.offsetHeight ?? 0;
    if (dh !== dockHeight.value) dockHeight.value = dh;
  }

  function updatePanesScrollbarWidth(): void {
    if (panesGeomRaf) return;
    panesGeomRaf = raf(() => {
      panesGeomRaf = 0;
      const el = panesRef.value;
      const sbw = el ? Math.max(0, el.offsetWidth - el.clientWidth) : 0;
      if (sbw !== panesScrollbarWidth.value) panesScrollbarWidth.value = sbw;
      updateDockHeight();
    });
  }

  function bindChatPane(el: Element | ComponentPublicInstance | null): void {
    const node = toHtmlEl(el);
    if (node === panesRef.value) return;
    panesRef.value = node;
    if (node) rebindScrollObservers();
  }

  function bindDock(node: HTMLElement | null): void {
    dockRef.value = node;
    ensureDockObserved();
    updateDockHeight();
  }

  const following = ref(true);
  const pillFar = ref(false);
  const showPill = computed(() => !following.value && pillFar.value);
  const panesScrolling = ref(false);
  let panesScrollHideTimer: ReturnType<typeof setTimeout> | null = null;

  const BOTTOM_THRESHOLD = 80;
  const USER_ACTION_FOLLOW_LOCK_MS = 1000;

  function distanceFromBottom(): number {
    const el = panesRef.value;
    if (!el) return 0;
    return lastObservedScrollHeight - lastScrollTop - lastObservedClientHeight;
  }

  let lastScrollTop = 0;
  let userActionFollowUntil = 0;
  let lastSmoothScroll = 0;
  let searchScrollFollowSuppressUntil = 0;
  let smoothScrollUntil = 0;
  const SMOOTH_SCROLL_GUARD_MS = 420;
  let stableFollowRaf = 0;
  let stableFollowToken = 0;

  function hasUserActionFollowLock(): boolean {
    return Date.now() < userActionFollowUntil;
  }

  let pillRaf = 0;

  function livePillVisible(el: HTMLElement): boolean {
    return nextJumpPillVisible(pillFar.value, el.scrollHeight - el.scrollTop - el.clientHeight, el.clientHeight);
  }

  function syncPill(el: HTMLElement): void {
    if (nextJumpPillVisible(pillFar.value, distanceFromBottom(), lastObservedClientHeight) === pillFar.value) return;
    if (pillFar.value) {
      pillFar.value = livePillVisible(el);
      return;
    }
    if (pillRaf) return;
    pillRaf = raf(() => {
      pillRaf = raf(() => {
        pillRaf = 0;
        const pane = panesRef.value;
        if (pane) pillFar.value = livePillVisible(pane);
      });
    });
  }

  function onPanesScroll(): void {
    panesScrolling.value = true;
    if (panesScrollHideTimer) clearTimeout(panesScrollHideTimer);
    panesScrollHideTimer = setTimeout(() => {
      panesScrolling.value = false;
      panesScrollHideTimer = null;
    }, 900);
    const el = panesRef.value;
    if (!el) return;
    const top = el.scrollTop;
    syncPill(el);

    if (isPinned()) {
      lastScrollTop = top;
      return;
    }

    if (performance.now() - lastSmoothScroll < 100 || (following.value && !pointerHeld && stableFollowRaf)) {
      lastScrollTop = top;
      return;
    }

    const dist = lastObservedScrollHeight - top - lastObservedClientHeight;
    if (hasUserActionFollowLock()) {
      following.value = true;
      lastScrollTop = top;
      return;
    }
    if (top < lastScrollTop - 1 && dist > 1) {
      const liveDist = el.scrollHeight - top - el.clientHeight;
      if (liveDist > 1) {
        if (pointerHeld || liveDist > BOTTOM_THRESHOLD) following.value = false;
        else if (following.value) scheduleFollow();
      }
    } else if (
      dist <= BOTTOM_THRESHOLD &&
      top > lastScrollTop + 1 &&
      Date.now() >= searchScrollFollowSuppressUntil &&
      (following.value || el.scrollHeight - top - el.clientHeight <= BOTTOM_THRESHOLD)
    ) {
      following.value = true;
    }
    lastScrollTop = top;
    scheduleActiveTocUpdate();
  }

  function scrollToBottom(smooth = false): void {
    const el = panesRef.value;
    following.value = true;
    cancelTocSettleCorrection();
    if (!el) return;
    if (!smooth && performance.now() < smoothScrollUntil) return;
    if (smooth) {
      smoothScrollToBottom();
    } else {
      el.scrollTop = Math.max(el.scrollTop, el.scrollHeight - el.clientHeight);
    }
    lastScrollTop = el.scrollTop;
  }

  let smoothRaf = 0;

  function smoothScrollToBottom(ms = 320): void {
    const el = panesRef.value;
    if (!el) return;
    if (smoothRaf) {
      cancelRaf(smoothRaf);
      smoothRaf = 0;
    }
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.scrollTop = el.scrollHeight;
      lastScrollTop = el.scrollTop;
      return;
    }
    const start = el.scrollTop;
    const t0 = performance.now();
    lastSmoothScroll = t0;
    smoothScrollUntil = t0 + ms + SMOOTH_SCROLL_GUARD_MS;
    const tick = () => {
      smoothRaf = 0;
      const p = Math.min(1, (performance.now() - t0) / ms);
      const ease = 1 - Math.pow(1 - p, 3);
      el.scrollTop = start + (el.scrollHeight - start) * ease;
      lastScrollTop = el.scrollTop;
      if (p < 1) {
        smoothRaf = raf(tick);
      } else {
        smoothScrollUntil = 0;
      }
    };
    smoothRaf = raf(tick);
  }

  type ScrollAnchor = { kind: 'turn' | 'tool'; id: string; top: number; messageId?: string };

  function scrollAnchorTop(container: HTMLElement, node: HTMLElement): number {
    const inert = node.closest<HTMLElement>('[inert]');
    const positionNode = inert?.closest<HTMLElement>('.tool-group, .activity-run, .turn-fold') ?? node;
    return (
      positionNode.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop
    );
  }

  function findTopAnchors(
    container: HTMLElement,
    scrollTop: number,
  ): ScrollAnchor[] {
    const anchors = Array.from(
      container.querySelectorAll<HTMLElement>('.turn-anchor[data-turn-id], [data-scroll-anchor-id]'),
    ).map((node) => ({ node, top: scrollAnchorTop(container, node) }));
    const firstAfterTop = anchors.findIndex((anchor) => anchor.top >= scrollTop);
    const start = firstAfterTop < 0 ? Math.max(0, anchors.length - 1) : firstAfterTop;
    return anchors.slice(start, start + 2).flatMap((anchor) => {
      const toolId = anchor.node.dataset.scrollAnchorId;
      const id = toolId ?? anchor.node.dataset.turnId;
      return id ? [{ kind: toolId ? 'tool' : 'turn', id, top: anchor.top, messageId: anchor.node.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId }] : [];
    });
  }

  type HistoryScrollSnapshot = {
    anchors: ScrollAnchor[];
    oldHeight: number;
  };

  const pendingHistoryRestoreBySession = new Map<string, HistoryScrollSnapshot>();

  function historyAnchorDelta(container: HTMLElement, snapshot: HistoryScrollSnapshot): number | null {
    for (const anchor of snapshot.anchors) {
      const attr = anchor.kind === 'tool' ? 'data-scroll-anchor-id' : 'data-turn-id';
      const newAnchor = container.querySelector<HTMLElement>(
        `[${attr}="${attrEscape(anchor.id)}"]`,
      );
      if (newAnchor) return scrollAnchorTop(container, newAnchor) - anchor.top;
    }
    return null;
  }

  function historyScrollDelta(container: HTMLElement, snapshot: HistoryScrollSnapshot): number {
    return historyAnchorDelta(container, snapshot) ?? container.scrollHeight - snapshot.oldHeight;
  }

  function restoreHistoryScroll(
    container: HTMLElement,
    snapshot: HistoryScrollSnapshot,
    currentTop: number,
  ): number {
    container.scrollTop = currentTop + historyScrollDelta(container, snapshot);
    lastScrollTop = container.scrollTop;
    return container.scrollTop;
  }

  async function handleLoadOlderMessages(): Promise<void> {
    if (
      !sessionId() ||
      loadingMore.value ||
      historyLoadInProgress.value ||
      !hasMoreMessages.value
    ) {
      return;
    }
    const requestedSessionId = sessionId()!;
    const el = panesRef.value;
    const snapshot: HistoryScrollSnapshot = {
      anchors: el ? findTopAnchors(el, el.scrollTop) : [],
      oldHeight: el?.scrollHeight ?? 0,
    };

    setHistoryLoadInProgress(requestedSessionId, true);
    cancelScheduledFollow();
    try {
      await nextTick();
      await loadOlderMessages(requestedSessionId);
      await nextTick();

      if (sessionId() !== requestedSessionId) {
        pendingHistoryRestoreBySession.set(requestedSessionId, snapshot);
        return;
      }

      const el2 = panesRef.value;
      if (!el2) return;

      if (!el2.querySelector('[data-virtual-scroll-root]')) restoreHistoryScroll(el2, snapshot, el2.scrollTop);
      pendingHistoryRestoreBySession.delete(requestedSessionId);
    } finally {
      setHistoryLoadInProgress(requestedSessionId, false);
    }
  }

  function attrEscape(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return value.replaceAll(/["\\]/g, '\\$&');
  }

  let tocSettleTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelTocSettleCorrection(): void {
    if (tocSettleTimer !== null) {
      clearTimeout(tocSettleTimer);
      tocSettleTimer = null;
    }
  }

  function settleTranscriptTarget(rect: () => DOMRect | undefined): void {
    cancelTocSettleCorrection();
    const until = performance.now() + 2000;
    const correct = () => {
      tocSettleTimer = null;
      const pane = panesRef.value;
      const target = rect();
      if (!pane || !target) return;
      const delta = target.top + target.height / 2 - (pane.getBoundingClientRect().top + pane.clientHeight / 2);
      if (Math.abs(delta) > 48) pane.scrollTop += delta;
      if (performance.now() < until) tocSettleTimer = setTimeout(correct, 120);
    };
    tocSettleTimer = setTimeout(correct, 480);
  }

  function revealTranscriptElement(target: HTMLElement): void {
    cancelActiveScrollWrites();
    following.value = false;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    settleTranscriptTarget(() => target.isConnected ? target.getBoundingClientRect() : undefined);
  }

  async function scrollToTurn(turnId: string): Promise<void> {
    const el = panesRef.value;
    if (!el) return;
    await chatPaneRef.value?.revealTurn(turnId);
    const target = el.querySelector<HTMLElement>(`.turn-anchor[data-turn-id="${attrEscape(turnId)}"]`);
    if (!target) return;
    revealTranscriptElement(target);
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
      if (canScrollY) {
        node.scrollTop += (rect.top + rect.height / 2) - (nodeRect.top + node.clientHeight / 2);
      }
      if (canScrollX) {
        node.scrollLeft += (rect.left + rect.width / 2) - (nodeRect.left + node.clientWidth / 2);
      }
    }
  }

  function revealTranscriptRange(range: Range): void {
    const el = panesRef.value;
    if (!el) return;
    const parent = range.startContainer.parentElement;
    cancelActiveScrollWrites();
    following.value = false;
    searchScrollFollowSuppressUntil = Date.now() + 700;
    const clampWrap = parent?.closest('.u-text-wrap.is-clamped');
    if (clampWrap) {
      clampWrap.querySelector<HTMLElement>('.u-text-toggle')?.click();
      void nextTick(() => revealTranscriptRangeAfterExpand(range, el));
      return;
    }
    revealTranscriptRangeAfterExpand(range, el);
  }

  function revealTranscriptRangeAfterExpand(range: Range, el: HTMLElement): void {
    const parent = range.startContainer.parentElement;
    scrollNestedContainersToRange(range, el);
    const rect = range.getClientRects()[0];
    if (!rect) {
      if (parent instanceof HTMLElement) revealTranscriptElement(parent);
      return;
    }
    const paneRect = el.getBoundingClientRect();
    const centerDelta = (rect.top + rect.height / 2) - (paneRect.top + el.clientHeight / 2);
    const smooth =
      typeof window === 'undefined' ||
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollTop + centerDelta, behavior: smooth ? 'smooth' : 'auto' });
    settleTranscriptTarget(() => range.startContainer.isConnected ? range.getClientRects()[0] : undefined);
  }

  function currentLayoutKey(): string {
    const el = panesRef.value;
    if (!el) return 'none';
    const content = el.firstElementChild;
    const contentHeight = content instanceof HTMLElement ? content.offsetHeight : 0;
    const dockHeight = dockRef.value?.offsetHeight ?? 0;
    return `${el.scrollHeight}:${el.clientHeight}:${contentHeight}:${dockHeight}`;
  }

  function raf(cb: () => void): number {
    return (typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(cb)
      : setTimeout(cb, 16)) as unknown as number;
  }

  function cancelRaf(id: number): void {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
    else clearTimeout(id);
  }

  let pinUntil = 0;
  let pinRaf = 0;
  let pinEl: HTMLElement | null = null;
  let pinTargetTop = 0;

  function isPinned(): boolean {
    return performance.now() < pinUntil;
  }

  function pinScrollFor(el: HTMLElement, ms = 200): void {
    const panes = panesRef.value;
    if (!panes) return;
    if (historyLoadInProgress.value) return;
    cancelActiveScrollWrites();
    following.value = false;
    pinEl = el;
    pinTargetTop = el.getBoundingClientRect().top;
    pinUntil = performance.now() + ms;
    if (pinRaf) return;
    const tick = () => {
      pinRaf = 0;
      if (!pinEl) return;
      if (following.value) {
        pinEl = null;
        return;
      }
      if (performance.now() >= pinUntil) {
        pinEl = null;
        settleAfterPin();
        return;
      }
      const delta = pinEl.getBoundingClientRect().top - pinTargetTop;
      if (delta) panes.scrollTop += delta;
      pinRaf = raf(tick);
    };
    pinRaf = raf(tick);
  }

  function settleAfterPin(): void {
    following.value = distanceFromBottom() <= BOTTOM_THRESHOLD;
  }

  function stabilizeAnchorForRestore(el: HTMLElement): void {
    const panes = panesRef.value;
    if (!panes || historyLoadInProgress.value) {
      liftSessionSettle();
      return;
    }
    following.value = false;
    pinEl = el;
    pinTargetTop = el.getBoundingClientRect().top;
    pinUntil = performance.now() + 1200;
    let lastKey = '';
    let stableFrames = 0;
    const finish = () => {
      pinEl = null;
      pinUntil = 0;
      settleAfterPin();
      liftSessionSettle();
    };
    const tick = () => {
      pinRaf = 0;
      if (!pinEl) return;
      if (following.value) {
        pinEl = null;
        pinUntil = 0;
        return;
      }
      if (!sessionSettling.value) {
        pinEl = null;
        pinUntil = 0;
        settleAfterPin();
        return;
      }
      if (performance.now() >= pinUntil) {
        finish();
        return;
      }
      const delta = pinEl.getBoundingClientRect().top - pinTargetTop;
      if (delta) panes.scrollTop += delta;
      const key = currentLayoutKey();
      stableFrames = delta === 0 && key === lastKey ? stableFrames + 1 : 0;
      lastKey = key;
      if (stableFrames >= 3) {
        finish();
        return;
      }
      pinRaf = raf(tick);
    };
    if (pinRaf) cancelRaf(pinRaf);
    pinRaf = raf(tick);
  }

  function scheduleStableFollow(maxFrames = 36, onDone?: () => void): void {
    if (!following.value && !hasUserActionFollowLock()) {
      onDone?.();
      return;
    }
    const token = ++stableFollowToken;
    let lastKey = '';
    let stableFrames = 0;
    let frames = 0;
    if (stableFollowRaf) {
      cancelRaf(stableFollowRaf);
      stableFollowRaf = 0;
    }

    const tick = () => {
      stableFollowRaf = 0;
      if (token !== stableFollowToken) return;
      if (!following.value && !hasUserActionFollowLock()) {
        onDone?.();
        return;
      }
      scrollToBottom(false);
      const key = currentLayoutKey();
      stableFrames = key === lastKey ? stableFrames + 1 : 0;
      lastKey = key;
      frames++;
      if (stableFrames < 3 && frames < maxFrames) {
        stableFollowRaf = raf(tick);
      } else {
        onDone?.();
      }
    };

    stableFollowRaf = raf(tick);
  }

  type ScrollKey = {
    length: number;
    firstId: string;
    lastId: string;
    lastTextLen: number;
    lastThinkingLen: number;
    lastToolsLen: number;
    approvalIds: string;
  };

  function isHistoryPrependOnly(prev: ScrollKey | undefined, next: ScrollKey): boolean {
    return (
      prev !== undefined &&
      prev.length > 0 &&
      next.length >= prev.length &&
      prev.firstId !== next.firstId &&
      prev.lastId === next.lastId &&
      prev.lastTextLen === next.lastTextLen &&
      prev.lastThinkingLen === next.lastThinkingLen &&
      prev.lastToolsLen === next.lastToolsLen &&
      prev.approvalIds === next.approvalIds
    );
  }

  const scrollKey = computed<ScrollKey>(() => {
    const approvalIds = approvals.value.map((a) => a.approvalId).join(',');
    const t = turns.value;
    const last = t.at(-1);
    const thinkingLen = last?.thinking?.length ?? 0;
    const toolsLen =
      last?.tools?.reduce(
        (n, tool) => n + tool.name.length + (tool.arg?.length ?? 0) + (tool.output?.join('').length ?? 0),
        0,
      ) ?? 0;
    return {
      length: t.length,
      firstId: t[0]?.id ?? '',
      lastId: last?.id ?? '',
      lastTextLen: last?.text.length ?? 0,
      lastThinkingLen: thinkingLen,
      lastToolsLen: toolsLen,
      approvalIds,
    };
  });

  let scrollKeySession: string | number | undefined = sessionId();

  watch(scrollKey, async (next, prev) => {
    const sid = sessionId();
    const crossSession = sid !== scrollKeySession;
    scrollKeySession = sid;
    if (historyLoadInProgress.value && isHistoryPrependOnly(prev, next)) {
      scheduleActiveTocUpdate();
      return;
    }
    if (crossSession || sessionSettling.value) {
      scheduleActiveTocUpdate();
      return;
    }
    await nextTick();
    if (following.value || hasUserActionFollowLock()) {
      scrollToBottom(next.length < prev.length);
    }
    scheduleActiveTocUpdate();
  });

  watch(dockRef, () => {
    ensureDockObserved();
  });

  watch(
    mobile,
    async () => {
      await nextTick();
      updatePanesScrollbarWidth();
    },
  );

  const scrollStateBySession = new Map<string, { top: number; following: boolean; anchor?: ScrollAnchor }>();

  const sessionSettling = ref(false);
  let settleLiftRaf = 0;
  let settleLiftTimer: ReturnType<typeof setTimeout> | null = null;

  function beginSessionSettle(): void {
    sessionSettling.value = true;
    if (settleLiftRaf) {
      cancelRaf(settleLiftRaf);
      settleLiftRaf = 0;
    }
    if (settleLiftTimer) clearTimeout(settleLiftTimer);
    settleLiftTimer = setTimeout(() => {
      sessionSettling.value = false;
      settleLiftTimer = null;
    }, 1200);
  }

  function liftSessionSettle(): void {
    if (!sessionSettling.value) return;
    let framesLeft = 2;
    const step = (): void => {
      settleLiftRaf = 0;
      framesLeft--;
      if (framesLeft > 0) {
        settleLiftRaf = raf(step);
        return;
      }
      sessionSettling.value = false;
      if (settleLiftTimer) {
        clearTimeout(settleLiftTimer);
        settleLiftTimer = null;
      }
    };
    if (settleLiftRaf) cancelRaf(settleLiftRaf);
    settleLiftRaf = raf(step);
  }

  let restoreGeneration = 0;

  async function restoreSessionScroll(sessionKey: string | undefined): Promise<void> {
    const gen = ++restoreGeneration;
    beginSessionSettle();
    await nextTick();
    if (gen !== restoreGeneration || sessionId() !== sessionKey) return;
    updateDockHeight();
    const el2 = panesRef.value;
    const saved = sessionKey ? scrollStateBySession.get(String(sessionKey)) : undefined;
    if (saved && el2) {
      following.value = saved.following;
      const pendingRestore = pendingHistoryRestoreBySession.get(String(sessionKey));
      let top = pendingRestore
        ? restoreHistoryScroll(el2, pendingRestore, saved.top)
        : saved.top;
      let savedAnchor: HTMLElement | null = null;
      if (!saved.following && saved.anchor) {
        await chatPaneRef.value?.revealTurn(saved.anchor.messageId ?? saved.anchor.id);
        if (gen !== restoreGeneration || sessionId() !== sessionKey) return;
        if (saved.anchor.kind === 'tool') {
          el2.scrollTop = top;
          await new Promise<void>(resolve => raf(() => raf(() => resolve())));
          await nextTick();
          if (gen !== restoreGeneration || sessionId() !== sessionKey) return;
        }
        const attr = saved.anchor.kind === 'tool' ? 'data-scroll-anchor-id' : 'data-turn-id';
        const anchor = el2.querySelector<HTMLElement>(`[${attr}="${attrEscape(saved.anchor.id)}"]`);
        if (anchor) {
          savedAnchor = anchor;
          top = scrollAnchorTop(el2, anchor) - saved.anchor.top;
        }
      }
      if (pendingRestore && sessionKey) pendingHistoryRestoreBySession.delete(String(sessionKey));
      following.value = saved.following;
      el2.scrollTop = top;
      lastScrollTop = el2.scrollTop;
      syncPill(el2);
      if (saved.following) {
        scheduleStableFollow(36, liftSessionSettle);
      } else {
        if (savedAnchor) stabilizeAnchorForRestore(savedAnchor);
        else liftSessionSettle();
      }
    } else {
      following.value = true;
      lastScrollTop = 0;
      scrollToBottom(false);
      scheduleStableFollow(36, liftSessionSettle);
    }
    markTocAnchorsDirty();
    updateActiveTocQuery();
  }

  watch(
    sessionId,
    async (newKey, oldKey) => {
      const el = panesRef.value;
      if (oldKey && el) {
        const anchor = findTopAnchors(el, el.scrollTop)[0];
        scrollStateBySession.set(String(oldKey), {
          top: el.scrollTop,
          following: following.value,
          anchor: anchor ? { ...anchor, top: anchor.top - el.scrollTop } : undefined,
        });
      }
      cancelActiveScrollWrites();
      pillFar.value = false;
      if (sessionLoading.value) {
        following.value = (newKey ? scrollStateBySession.get(String(newKey))?.following : undefined) ?? true;
        beginSessionSettle();
        return;
      }
      await restoreSessionScroll(newKey);
    },
  );

  watch(
    () => sessionLoading.value,
    async (loading, was) => {
      if (loading) {
        beginSessionSettle();
        return;
      }
      if (!was) return;
      await restoreSessionScroll(sessionId());
    },
    { immediate: true },
  );

  watch(
    () => turnActive.value,
    async (now, was) => {
      if (now || !was) return;
      if (!following.value && !hasUserActionFollowLock()) return;
      await nextTick();
      scheduleStableFollow(48);
      scheduleActiveTocUpdate();
    },
  );

  function followAfterUserAction(): void {
    following.value = true;
    userActionFollowUntil = Date.now() + USER_ACTION_FOLLOW_LOCK_MS;
    void nextTick(() => {
      scrollToBottom(true);
      scheduleStableFollow(16);
    });
  }

  function lockFollowForUserAction(): void {
    following.value = true;
    userActionFollowUntil = Date.now() + USER_ACTION_FOLLOW_LOCK_MS;
  }

  let contentObserver: MutationObserver | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let observedContent: Element | null = null;
  let observedDock: HTMLElement | null = null;
  let lastObservedScrollHeight = 0;
  let lastObservedClientHeight = 0;
  let scrollRaf = 0;
  const historyLoadingSessions = ref<ReadonlySet<string>>(new Set());
  const historyLoadInProgress = computed(
    () => !!sessionId() && historyLoadingSessions.value.has(sessionId()!),
  );

  function setHistoryLoadInProgress(sessionId: string, inProgress: boolean): void {
    const next = new Set(historyLoadingSessions.value);
    if (inProgress) next.add(sessionId);
    else next.delete(sessionId);
    historyLoadingSessions.value = next;
  }

  function scheduleFollow(): void {
    if (historyLoadInProgress.value) return;
    if (scrollRaf) return;
    scrollRaf = raf(() => {
      scrollRaf = 0;
      if (historyLoadInProgress.value) return;
      if (isPinned()) return;
      if (following.value || hasUserActionFollowLock()) scrollToBottom(false);
    });
  }

  function followNow(): void {
    if (following.value && !historyLoadInProgress.value) scrollToBottom(false);
    else scheduleFollow();
  }

  function cancelScheduledFollow(): void {
    stableFollowToken++;
    if (stableFollowRaf) {
      cancelRaf(stableFollowRaf);
      stableFollowRaf = 0;
    }
    if (scrollRaf) {
      cancelRaf(scrollRaf);
      scrollRaf = 0;
    }
  }

  function cancelActiveScrollWrites(): void {
    ++restoreGeneration;
    const el = panesRef.value;
    if (el) pendingHistoryScrolls.delete(el);

    userActionFollowUntil = 0;
    searchScrollFollowSuppressUntil = 0;
    cancelScheduledFollow();
    pinUntil = 0;
    pinEl = null;
    if (smoothRaf) {
      cancelRaf(smoothRaf);
      smoothRaf = 0;
    }
    cancelTocSettleCorrection();

    if (el) {
      const top = el.scrollTop;
      if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'auto' });
      else el.scrollTop = top;
    }
    smoothScrollUntil = 0;
    lastSmoothScroll = Number.NEGATIVE_INFINITY;
    if (el) lastScrollTop = el.scrollTop;
    liftSessionSettle();
  }

  function stopFollowingForUserIntent(): void {
    const el = panesRef.value;
    if (!el || (el.scrollHeight - el.clientHeight <= 1 && !hasMoreMessages.value && !sessionSettling.value && !isPinned())) return;

    following.value = false;
    cancelActiveScrollWrites();
  }

  function upwardScrollStaysNested(event: Event): boolean {
    const pane = panesRef.value;
    return pane !== null && nestedScrollerTakesUpwardScroll(event.composedPath(), pane);
  }

  function onPanesWheel(event: WheelEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.shiftKey) return;
    cancelTocSettleCorrection();
    if (event.deltaY > 0) {
      if (sessionSettling.value || isPinned()) cancelActiveScrollWrites();
      const el = panesRef.value;
      if (el && !following.value && distanceFromBottom() <= 1 && el.scrollHeight - el.scrollTop - el.clientHeight <= 1) {
        following.value = true;
      }
      return;
    }
    if (event.deltaY === 0 || upwardScrollStaysNested(event)) return;
    stopFollowingForUserIntent();
  }

  let pointerHeld = false;

  function releasePointer(): void {
    pointerHeld = false;
  }

  function onPanesPointerDown(event: PointerEvent): void {
    pointerHeld = true;
    const el = panesRef.value;
    if (!el || event.defaultPrevented || event.button !== 0 || event.pointerType === 'touch') return;
    const rect = el.getBoundingClientRect();
    const gutterWidth = el.offsetWidth - el.clientWidth;
    const hitWidth = gutterWidth > 0 ? gutterWidth : 12;
    if (event.target === el && event.clientX >= rect.right - hitWidth) {
      stopFollowingForUserIntent();
    }
  }

  let lastTouchY: number | null = null;

  function onPanesTouchStart(event: TouchEvent): void {
    lastTouchY = event.touches.length === 1 ? event.touches[0]!.clientY : null;
  }

  function onPanesTouchMove(event: TouchEvent): void {
    const y = event.touches.length === 1 ? event.touches[0]!.clientY : null;
    cancelTocSettleCorrection();
    if (y !== null && lastTouchY !== null) {
      if (y < lastTouchY - 2) {
        if (sessionSettling.value || isPinned()) cancelActiveScrollWrites();
      } else if (y > lastTouchY + 2 && !upwardScrollStaysNested(event)) {
        stopFollowingForUserIntent();
      }
    }
    lastTouchY = y;
  }

  function ensureContentObserved(): void {
    if (!resizeObserver) return;
    const el = panesRef.value?.firstElementChild ?? null;
    if (el === observedContent) return;
    if (observedContent) resizeObserver.unobserve(observedContent);
    observedContent = el;
    if (el) resizeObserver.observe(el);
  }

  function ensureDockObserved(): void {
    if (!resizeObserver) return;
    const el = dockRef.value;
    if (el === observedDock) return;
    if (observedDock) resizeObserver.unobserve(observedDock);
    observedDock = el;
    if (el) resizeObserver.observe(el);
  }

  function rebindScrollObservers(): void {
    const el = panesRef.value;
    updatePanesScrollbarWidth();
    if (contentObserver) {
      contentObserver.disconnect();
      if (el) contentObserver.observe(el, { childList: true, subtree: true, characterData: true });
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      observedContent = null;
      observedDock = null;
      if (el) resizeObserver.observe(el);
      ensureContentObserved();
      ensureDockObserved();
    }
    lastObservedScrollHeight = el?.scrollHeight ?? 0;
    lastObservedClientHeight = el?.clientHeight ?? 0;
    syncWideTableToc();
    markTocAnchorsDirty();
  }

  function onContentMutated(): void {
    ensureContentObserved();
    scheduleFollow();
    syncWideTableToc();
  }

  function onVisibilityChange(): void {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'visible' && following.value) {
      scheduleStableFollow();
    }
  }

  function onTranscriptKeyDown(event: KeyboardEvent): void {
    const scrollDirection = scrollKeyDirection(event);
    if (
      scrollDirection !== 0 &&
      !event.defaultPrevented && !keyScrollBlocked(event) && !isEditableTarget(event.target) &&
      event.target instanceof Element &&
      (panesRef.value?.contains(event.target) || event.target === document.body) &&
      (event.key !== ' ' || !event.target.closest('button, a[href], select, summary, [role="button"]'))
    ) {
      if (scrollDirection < 0) stopFollowingForUserIntent();
      else if (!following.value) cancelActiveScrollWrites();
    }
  }

  function onVisualViewportResize(): void {
    if (following.value) scheduleFollow();
  }

  onMounted(() => {
    void nextTick(() => {
      if (typeof MutationObserver === 'function') {
        contentObserver = new MutationObserver(onContentMutated);
      }
      if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver((entries) => {
          markTocAnchorsDirty();
          updatePanesScrollbarWidth();
          if (entries.some((entry) => entry.target === dockRef.value)) updateDockHeight();
          const el = panesRef.value;
          if (!el) return;
          const { scrollHeight, clientHeight } = el;
          const grew = scrollHeight > lastObservedScrollHeight + 1;
          const viewportShrank = clientHeight < lastObservedClientHeight - 1;
          lastObservedScrollHeight = scrollHeight;
          lastObservedClientHeight = clientHeight;
          if (!isPinned() && (grew || viewportShrank)) followNow();
          syncPill(el);
        });
      }
      rebindScrollObservers();
      if (!sessionLoading.value) scheduleStableFollow(48);
      updateActiveTocQuery();
      panesRef.value?.addEventListener('kimi-table-layout', onTableLayout);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibilityChange);
        document.addEventListener('pointerup', releasePointer, true);
        document.addEventListener('pointercancel', releasePointer, true);
      }
      window.visualViewport?.addEventListener('resize', onVisualViewportResize);
    });
  });

  onUnmounted(() => {
    panesRef.value?.removeEventListener('kimi-table-layout', onTableLayout);
    if (contentObserver) contentObserver.disconnect();
    if (resizeObserver) resizeObserver.disconnect();
    if (scrollRaf) cancelRaf(scrollRaf);
    if (stableFollowRaf) cancelRaf(stableFollowRaf);
    if (pinRaf) cancelRaf(pinRaf);
    if (smoothRaf) cancelRaf(smoothRaf);
    if (pillRaf) cancelRaf(pillRaf);
    if (activeTocRaf) cancelRaf(activeTocRaf);
    if (tocSettleTimer !== null) clearTimeout(tocSettleTimer);
    if (panesScrollHideTimer) clearTimeout(panesScrollHideTimer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('pointerup', releasePointer, true);
      document.removeEventListener('pointercancel', releasePointer, true);
    }
    window.visualViewport?.removeEventListener('resize', onVisualViewportResize);
  });

  return {
    panesRef,
    dockRef,
    bindChatPane,
    bindDock,
    following,
    showPill,
    panesScrolling,
    sessionSettling,
    dockHeight,
    contentWrapStyle,
    chatDockStyle,
    activeTurnId,
    onPanesScroll,
    onPanesWheel,
    onPanesPointerDown,
    onPanesTouchStart,
    onPanesTouchMove,
    onTranscriptKeyDown,
    scrollToBottom,
    scrollToTurn,
    revealTranscriptRange,
    followAfterUserAction,
    lockFollowForUserAction,
    handleLoadOlderMessages,
  };
}
