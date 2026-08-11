import { nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue';

const BOTTOM_THRESHOLD = 24;

export function useFollowScroll(identity: Ref<string | null>) {
  const scroller = ref<HTMLElement | null>(null);
  const following = ref(true);
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let observedContent: Element | null = null;
  let lastScrollHeight = 0;
  let lastClientHeight = 0;
  let disclosurePending = false;
  let disclosureToken = 0;

  function scrollToBottom(): void {
    const element = scroller.value;
    if (element) element.scrollTop = Math.max(element.scrollTop, lastScrollHeight);
  }

  function observeContent(): void {
    const element = scroller.value;
    const content = element?.firstElementChild ?? null;
    if (content === observedContent) return;
    if (observedContent) resizeObserver?.unobserve(observedContent);
    observedContent = content;
    if (content) resizeObserver?.observe(content);
  }

  function onScroll(): void {
    const element = scroller.value;
    if (!element || disclosurePending) return;
    following.value =
      lastScrollHeight - element.scrollTop - lastClientHeight < BOTTOM_THRESHOLD;
  }

  function settleDisclosure(token: number): void {
    if (token !== disclosureToken || !disclosurePending) return;
    disclosurePending = false;
    onScroll();
  }

  function pinScroll(): void {
    following.value = false;
    disclosurePending = true;
    const token = ++disclosureToken;
    if (typeof requestAnimationFrame !== 'function') {
      queueMicrotask(() => settleDisclosure(token));
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => settleDisclosure(token));
    });
  }

  function bind(): void {
    const element = scroller.value;
    if (!element) return;
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    observedContent = null;
    disclosurePending = false;
    disclosureToken++;
    lastScrollHeight = 0;
    lastClientHeight = 0;
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        const current = scroller.value;
        if (!current) return;
        const { scrollHeight, clientHeight } = current;
        const grew = scrollHeight > lastScrollHeight + 1;
        const viewportShrank = clientHeight < lastClientHeight - 1;
        lastScrollHeight = scrollHeight;
        lastClientHeight = clientHeight;
        if (disclosurePending) {
          settleDisclosure(disclosureToken);
          return;
        }
        if (following.value && (grew || viewportShrank)) scrollToBottom();
      });
      resizeObserver.observe(element);
      observeContent();
    } else {
      lastScrollHeight = element.scrollHeight;
      lastClientHeight = element.clientHeight;
      scrollToBottom();
    }
    if (typeof MutationObserver === 'function') {
      mutationObserver = new MutationObserver(observeContent);
      mutationObserver.observe(element, { childList: true });
    }
  }

  watch(identity, () => {
    following.value = true;
    void nextTick(bind);
  });
  watch(scroller, () => void nextTick(bind));
  onMounted(() => void nextTick(bind));
  onUnmounted(() => {
    disclosureToken++;
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
  });

  return { scroller, following, onScroll, pinScroll };
}
