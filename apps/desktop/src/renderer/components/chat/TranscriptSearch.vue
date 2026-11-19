<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, IconButton, Spinner, useImeComposition } from '@moonshot-ai/app-ui';
import {
  clearSearchHighlights,
  collectMatchRanges,
  setSearchHighlights,
} from '@moonshot-ai/app-core/lib';
import { track } from '../../lib/track';

const props = withDefaults(
  defineProps<{
    pane: HTMLElement | null;
    reveal: (range: Range) => void;
    mobile?: boolean;
  }>(),
  { mobile: false },
);
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

const SEARCH_DEBOUNCE_MS = 800;
const MUTATION_DEBOUNCE_MS = 400;
const STREAM_REFRESH_MAX_WAIT_MS = 1500;

const query = ref('');
const searching = ref(false);
const matches = ref<Range[]>([]);
const current = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);

const total = computed(() => matches.value.length);
const footerVisible = computed(() => query.value.trim() !== '' && !searching.value);
const truncated = ref(false);
const countLabel = computed(() => {
  if (total.value === 0) return t('conversation.search.noResults');
  const params = { current: current.value + 1, total: total.value };
  return truncated.value
    ? t('conversation.search.resultsCapped', params)
    : t('conversation.search.results', params);
});

let searchTimer: ReturnType<typeof setTimeout> | null = null;
let mutationTimer: ReturnType<typeof setTimeout> | null = null;
let observer: MutationObserver | null = null;
let paneResizeObserver: ResizeObserver | null = null;
let scrollRingTimer: ReturnType<typeof setTimeout> | null = null;
let lastAutoRefreshAt = 0;

interface RingRect {
  top: string;
  left: string;
  width: string;
  height: string;
}
const ringRects = ref<RingRect[]>([]);

function updateRings(): void {
  const pane = props.pane;
  const range = matches.value[current.value];
  if (!pane || range === undefined) {
    ringRects.value = [];
    return;
  }
  const paneRect = pane.getBoundingClientRect();
  const rects: RingRect[] = [];
  for (const rect of range.getClientRects()) {
    rects.push({
      top: `${rect.top - paneRect.top + pane.scrollTop}px`,
      left: `${rect.left - paneRect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }
  ringRects.value = rects;
}

function isIgnorableMutation(mutation: MutationRecord, pane: HTMLElement | null): boolean {
  if (mutation.type === 'attributes' && mutation.target === pane) return true;
  return isRingOverlayMutation(mutation);
}

function isRingOverlayMutation(mutation: MutationRecord): boolean {
  const isOurs = (node: Node | null): boolean =>
    node instanceof Element &&
    (node.classList.contains('tsearch-rings') || node.closest('.tsearch-rings') !== null);
  if (isOurs(mutation.target)) return true;
  if (mutation.type === 'childList') {
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    if (nodes.length > 0 && nodes.every(isOurs)) return true;
  }
  return false;
}

function onPaneScroll(): void {
  if (ringRects.value.length === 0) return;
  if (scrollRingTimer !== null) clearTimeout(scrollRingTimer);
  scrollRingTimer = setTimeout(() => {
    scrollRingTimer = null;
    updateRings();
  }, 120);
}

function transcriptRoot(): Element | null {
  return props.pane?.querySelector('.chat') ?? null;
}

function onQueryInput(): void {
  if (searchTimer !== null) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  if (query.value.trim() === '') {
    searching.value = false;
    runSearch();
    return;
  }
  searching.value = true;
  searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
}

function resultCountBucket(count: number): '0' | '1-10' | '11-50' | '50+' {
  if (count === 0) return '0';
  if (count <= 10) return '1-10';
  if (count <= 50) return '11-50';
  return '50+';
}

function runSearch(reveal: 'first' | 'backward' | false = 'first'): void {
  if (searchTimer !== null) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  searching.value = false;
  const root = transcriptRoot();
  if (query.value.trim() === '' || root === null) {
    matches.value = [];
    truncated.value = false;
    current.value = 0;
    clearSearchHighlights();
    updateRings();
    return;
  }
  const anchor = matches.value[current.value];
  const anchorNode = anchor?.startContainer ?? null;
  const anchorOffset = anchor?.startOffset ?? 0;
  const result = collectMatchRanges(root, query.value.trim());
  const found = result.ranges;
  truncated.value = result.truncated;
  matches.value = found;
  if (reveal !== false) {
    track('search_executed', {
      scope: 'current_session',
      result_count_bucket: resultCountBucket(found.length),
    });
  }
  if (found.length === 0) {
    current.value = 0;
    setSearchHighlights([], 0);
    updateRings();
    return;
  }
  if (reveal !== false) {
    const first = firstMatchInView(found);
    current.value = reveal === 'backward' ? (first - 1 + found.length) % found.length : first;
    revealMatch();
    return;
  }
  const kept =
    anchorNode !== null
      ? found.findIndex((r) => r.startContainer === anchorNode && r.startOffset === anchorOffset)
      : -1;
  current.value = kept >= 0 ? kept : firstMatchInView(found);
  setSearchHighlights(found, current.value);
  updateRings();
}

function firstMatchInView(ranges: Range[]): number {
  const paneTop = props.pane?.getBoundingClientRect().top ?? 0;
  const index = ranges.findIndex((range) => {
    const rects = range.getClientRects();
    const last = rects[rects.length - 1];
    return last !== undefined && last.bottom >= paneTop;
  });
  return index === -1 ? 0 : index;
}

function revealMatch(): void {
  const range = matches.value[current.value];
  setSearchHighlights(matches.value, current.value);
  if (range !== undefined) props.reveal(range);
  updateRings();
}

function step(delta: number): void {
  if (total.value === 0) return;
  current.value = (current.value + delta + total.value) % total.value;
  revealMatch();
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return;
  if (isComposingKeyEvent(event)) return;
  event.preventDefault();
  if (searchTimer !== null) {
    runSearch(event.shiftKey ? 'backward' : 'first');
    return;
  }
  step(event.shiftKey ? -1 : 1);
}

function onContainerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (isComposingKeyEvent(event)) return;
  event.preventDefault();
  event.stopPropagation();
  emit('close');
}

function focusInput(): void {
  const el = inputRef.value;
  if (!el) return;
  el.focus();
  el.select();
}
defineExpose({ focusInput });

onMounted(() => {
  void nextTick(() => inputRef.value?.focus());
  if (props.pane && typeof MutationObserver === 'function') {
    observer = new MutationObserver((mutations) => {
      if (query.value.trim() === '') return;
      if (mutations.every((m) => isIgnorableMutation(m, props.pane))) return;
      if (searchTimer !== null) return;
      if (Date.now() - lastAutoRefreshAt >= STREAM_REFRESH_MAX_WAIT_MS) {
        lastAutoRefreshAt = Date.now();
        if (mutationTimer !== null) {
          clearTimeout(mutationTimer);
          mutationTimer = null;
        }
        runSearch(false);
        return;
      }
      if (mutationTimer !== null) clearTimeout(mutationTimer);
      mutationTimer = setTimeout(() => {
        mutationTimer = null;
        if (searchTimer !== null) return;
        lastAutoRefreshAt = Date.now();
        runSearch(false);
      }, MUTATION_DEBOUNCE_MS);
    });
    observer.observe(props.pane, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['inert', 'style', 'class'],
    });
  }
  props.pane?.addEventListener('scroll', onPaneScroll, { passive: true });
  const layoutTargets = [props.pane, props.pane?.querySelector('.content-wrap') ?? null];
  if (typeof ResizeObserver === 'function') {
    paneResizeObserver = new ResizeObserver(() => updateRings());
    for (const target of layoutTargets) {
      if (target) paneResizeObserver.observe(target);
    }
  }
});

onUnmounted(() => {
  if (searchTimer !== null) clearTimeout(searchTimer);
  if (mutationTimer !== null) clearTimeout(mutationTimer);
  if (scrollRingTimer !== null) clearTimeout(scrollRingTimer);
  observer?.disconnect();
  observer = null;
  paneResizeObserver?.disconnect();
  paneResizeObserver = null;
  props.pane?.removeEventListener('scroll', onPaneScroll);
  clearSearchHighlights();
});
</script>

<template>
  <div class="tsearch" :class="{ mobile }" role="search" @keydown="onContainerKeydown">
    <div class="tsearch-main">
      <Icon class="tsearch-icon" name="search" size="sm" aria-hidden="true" />
      <input
        ref="inputRef"
        v-model="query"
        type="text"
        class="tsearch-input"
        :placeholder="t('conversation.search.placeholder')"
        autocapitalize="off"
        autocomplete="off"
        spellcheck="false"
        @input="onQueryInput"
        @keydown="onInputKeydown"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
      />
      <span v-if="searching" class="tsearch-spin">
        <Spinner size="sm" :label="t('conversation.search.searching')" />
      </span>
      <span class="tsearch-sep" aria-hidden="true" />
      <IconButton class="tsearch-close" size="sm" :label="t('conversation.search.close')" :tooltip="t('conversation.search.close')" @click="emit('close')">
        <Icon name="close" />
      </IconButton>
    </div>
    <div class="tsearch-foot-wrap" :class="{ open: footerVisible }" :inert="!footerVisible">
      <div class="tsearch-foot">
        <IconButton
          size="sm"
          :label="t('conversation.search.previous')"
          :tooltip="t('conversation.search.previous')"
          :disabled="total === 0"
          @click="step(-1)"
        >
          <Icon name="arrow-up" />
        </IconButton>
        <IconButton
          size="sm"
          :label="t('conversation.search.next')"
          :tooltip="t('conversation.search.next')"
          :disabled="total === 0"
          @click="step(1)"
        >
          <Icon name="arrow-down" />
        </IconButton>
        <span class="tsearch-count" role="status">{{ countLabel }}</span>
      </div>
    </div>

    <Teleport v-if="pane" :to="pane">
      <div class="tsearch-rings" aria-hidden="true">
        <div v-for="(rect, i) in ringRects" :key="i" class="tsearch-ring" :style="rect" />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tsearch {
  position: absolute;
  top: calc(var(--panel-head-h, 48px) + var(--space-3));
  right: var(--space-3);
  z-index: var(--z-sticky);
  width: min(var(--p-findbar-w), calc(100% - var(--space-3) * 2));
  background: var(--color-surface-raised);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-menu);
  animation: kimi-card-in var(--duration-slow) var(--ease-out);
}
.tsearch.mobile {
  top: var(--space-3);
}
.tsearch::after {
  content: '';
  position: absolute;
  inset: 0;
  border: inherit;
  border-color: var(--color-composer-focus-line);
  border-radius: var(--radius-2xl);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-slow) var(--ease-in-out);
}
.tsearch:focus-within::after {
  opacity: 1;
}

.tsearch-main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  min-height: calc(var(--space-8) + 2 * var(--space-1));
}
.tsearch-icon {
  flex: none;
  margin-left: var(--space-1);
  color: var(--color-text-muted);
}
.tsearch-input {
  flex: 1;
  min-width: 0;
  height: var(--space-8);
  padding: 0;
  border: none;
  background: transparent;
  font-family: var(--font-ui);
  font-size: var(--ui-font-size);
  color: var(--color-text);
}
.tsearch-input:focus-visible {
  outline: none;
}
.tsearch-input::placeholder {
  color: var(--color-text-muted);
}
.tsearch-spin {
  display: inline-flex;
  flex: none;
}
.tsearch-sep {
  flex: none;
  width: var(--p-hairline);
  height: var(--space-4);
  background: var(--color-line);
}
.tsearch .tsearch-close {
  border-radius: var(--radius-full);
}

.tsearch-foot-wrap {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--duration-slow) var(--ease-out);
}
.tsearch-foot-wrap.open {
  grid-template-rows: 1fr;
}
.tsearch-foot {
  overflow: hidden;
  min-height: 0;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
}
.tsearch-foot-wrap.open .tsearch-foot {
  padding: var(--space-1) var(--space-2);
  border-top: var(--p-hairline) solid var(--color-line);
}
.tsearch-count {
  margin-left: auto;
  padding-right: var(--space-1);
  font-size: var(--ui-font-size-sm);
  color: var(--color-text-muted);
  white-space: nowrap;
  user-select: none;
}

.tsearch-rings {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.tsearch-ring {
  position: absolute;
  box-sizing: content-box;
  border: var(--p-findring-w) solid var(--color-warning);
  margin: calc(-1 * var(--p-findring-w));
  border-radius: var(--radius-xs);
  pointer-events: none;
}
</style>
