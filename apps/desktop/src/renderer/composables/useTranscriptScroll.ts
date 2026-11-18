import { computed, nextTick, watch, type ComponentPublicInstance } from 'vue';
import { isEditableTarget, scrollKeyDirection } from '@moonshot-ai/app-core/lib';
import { TRANSCRIPT_DOCK_FADE_PX, useTranscriptScroll } from '@moonshot-ai/app-client/composables';
import { toHtmlEl, type LegacyTranscriptScrollOptions, type TranscriptScrollBinding } from './useLegacyTranscriptScroll';

export function useTranscriptScrollBinding(options: LegacyTranscriptScrollOptions): TranscriptScrollBinding {
  const {
    sessionId,
    mobile,
    turns,
    hasMoreMessages,
    loadingMore,
    conversationTocItems,
    loadOlderMessages,
    syncWideTableToc,
    keyScrollBlocked,
  } = options;

  const scroll = useTranscriptScroll({ sessionId, touch: () => mobile() === true });
  const loadingOlder = new Set<string>();

  const contentWrapStyle = computed(() => ({ paddingBottom: `${scroll.dockHeight.value + TRANSCRIPT_DOCK_FADE_PX}px` }));
  const chatDockStyle = computed(() => ({ '--panes-scrollbar-width': `${scroll.scrollbarWidth.value}px` }));
  const sessionSettling = computed(() => false);

  const turnQuestionIds = computed(() => {
    const result = new Map<string, string>();
    let questionId: string | null = null;
    for (const turn of turns.value) {
      if (turn.role === 'user') questionId = turn.id;
      if (questionId !== null) result.set(turn.id, questionId);
    }
    return result;
  });

  const activeTurnId = computed<string | null>(() => {
    const items = conversationTocItems.value;
    if (items.length === 0) return null;
    if (scroll.following.value) return items[items.length - 1]!.id;
    const key = scroll.activeRowKey.value;
    return (key === null ? undefined : turnQuestionIds.value.get(key)) ?? items[0]!.id;
  });

  function bindChatPane(el: Element | ComponentPublicInstance | null): void {
    const node = toHtmlEl(el);
    if (node === scroll.scroller.value) return;
    scroll.scroller.value?.removeEventListener('kimi-table-layout', syncWideTableToc);
    node?.addEventListener('kimi-table-layout', syncWideTableToc);
    scroll.bindScroller(node);
  }

  function onTranscriptKeyDown(event: KeyboardEvent): void {
    if (
      scrollKeyDirection(event) !== 0 &&
      !event.defaultPrevented && !keyScrollBlocked(event) && !isEditableTarget(event.target) &&
      event.target instanceof Element &&
      (scroll.scroller.value?.contains(event.target) || event.target === document.body) &&
      (event.key !== ' ' || !event.target.closest('button, a[href], select, summary, [role="button"]'))
    ) {
      scroll.onInput(event);
    }
  }

  function revealTranscriptRange(range: Range): void {
    const clampWrap = range.startContainer.parentElement?.closest('.u-text-wrap.is-clamped');
    if (clampWrap) {
      clampWrap.querySelector<HTMLElement>('.u-text-toggle')?.click();
      void nextTick(() => scroll.revealRange(range));
      return;
    }
    scroll.revealRange(range);
  }

  function followAfterUserAction(): void {
    scroll.follow({ smooth: true });
  }

  async function handleLoadOlderMessages(): Promise<void> {
    const sid = sessionId();
    if (!sid || loadingMore.value || loadingOlder.has(sid) || !hasMoreMessages.value) return;
    loadingOlder.add(sid);
    try {
      await loadOlderMessages(sid);
    } finally {
      loadingOlder.delete(sid);
    }
  }

  watch(() => [sessionId(), turns.value.length], () => syncWideTableToc(), { flush: 'post' });

  return {
    panesRef: scroll.scroller,
    dockRef: scroll.dock,
    bindChatPane,
    bindDock: scroll.bindDock,
    following: scroll.following,
    showPill: scroll.showJump,
    panesScrolling: scroll.scrolling,
    sessionSettling,
    dockHeight: scroll.dockHeight,
    contentWrapStyle,
    chatDockStyle,
    activeTurnId,
    onPanesScroll: scroll.onScroll,
    onPanesWheel: scroll.onInput,
    onPanesPointerDown: scroll.onInput,
    onPanesTouchStart: scroll.onInput,
    onPanesTouchMove: scroll.onInput,
    onTranscriptKeyDown,
    scrollToBottom: (smooth = false) => scroll.follow({ smooth }),
    scrollToTurn: scroll.navigateToTurn,
    revealTranscriptRange,
    followAfterUserAction,
    lockFollowForUserAction: followAfterUserAction,
    handleLoadOlderMessages,
  };
}
