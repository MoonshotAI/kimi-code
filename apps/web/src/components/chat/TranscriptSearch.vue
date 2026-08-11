<!-- apps/web/src/components/chat/TranscriptSearch.vue -->
<!-- Transcript find bar (Cmd/Ctrl+F): a floating card pinned to the
     transcript's top-right — input pill that expands a prev/next + count
     footer once a query settles. Matches are counted over the rendered
     transcript DOM only (unloaded older pages are not searched). -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, IconButton, Spinner, useImeComposition } from '@moonshot-ai/app-ui';
import {
  clearSearchHighlights,
  collectMatchRanges,
  setSearchHighlights,
} from '@moonshot-ai/app-core/lib';

const props = withDefaults(
  defineProps<{
    /** Transcript scroll container (.panes) — the search scopes to its .chat. */
    pane: HTMLElement | null;
    /** Scroll a match's Range into view (ConversationPane's reveal dance:
        centers the match rect, breaks the bottom-follow, re-centers past
        content-visibility drift). */
    reveal: (range: Range) => void;
    /** Compact layout (no ChatHeader above the pane). */
    mobile?: boolean;
  }>(),
  { mobile: false },
);
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

// IME composition guard (CJK input methods): Enter confirming a candidate is
// NOT a next-match command — the same contract every Enter-submitting input
// in this repo follows (composer, conversation Esc handler).
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

// Typing pause before a search fires (the "about a second" from the spec).
const SEARCH_DEBOUNCE_MS = 800;
// Streaming output mutates the transcript constantly; re-searches trail the
// last mutation instead of running per batch — but with a max wait, so an
// uninterrupted stream still refreshes periodically instead of starving
// the count until it ends.
const MUTATION_DEBOUNCE_MS = 400;
const STREAM_REFRESH_MAX_WAIT_MS = 1500;

const query = ref('');
const searching = ref(false);
const matches = ref<Range[]>([]);
const current = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);

const total = computed(() => matches.value.length);
// The footer only exists once a query has produced a settled result set —
// while typing (or with an empty query) the bar stays a bare pill.
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

// The current match's 2px outline ring (one per line box), in pane content
// coordinates so it scrolls with the transcript. ::highlight can't paint box
// outlines, hence a real element teleported into the pane.
function updateRings(): void {
  const pane = props.pane;
  const range = matches.value[current.value];
  if (!pane || range === undefined) {
    ringRects.value = [];
    return;
  }
  const paneRect = pane.getBoundingClientRect();
  const rects: RingRect[] = [];
  // Exact match rects in pane content coordinates — the visual outset comes
  // from CSS (border + negative margin share one --findring-w), so geometry
  // can't drift between JS and the stylesheet.
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

// Mutations the transcript observer ignores: (a) the ring overlay teleported
// into the pane (no self-triggering), and (b) the pane's OWN attribute
// changes — its `scrolling` class toggles on every scroll, and re-running a
// full search each time would jank scrolling itself.
function isIgnorableMutation(mutation: MutationRecord, pane: HTMLElement | null): boolean {
  if (mutation.type === 'attributes' && mutation.target === pane) return true;
  return isRingOverlayMutation(mutation);
}

// The ring overlay teleports into the pane; the transcript observer must
// ignore mutations that are entirely our own overlay (no self-triggering).
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

// Layout shifts that don't mutate the DOM (content-visibility re-estimates,
// resizes) move the match rects — re-derive the ring on scroll settle.
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
  // Clearing the field responds at once (highlights off, footer folds) —
  // the debounce only gates real queries.
  if (query.value.trim() === '') {
    searching.value = false;
    runSearch();
    return;
  }
  searching.value = true;
  searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
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
  // Anchor the current match by identity (boundary node + offset), not by
  // number: prepended history shifts every index.
  const anchor = matches.value[current.value];
  const anchorNode = anchor?.startContainer ?? null;
  const anchorOffset = anchor?.startOffset ?? 0;
  const result = collectMatchRanges(root, query.value.trim());
  const found = result.ranges;
  truncated.value = result.truncated;
  matches.value = found;
  if (found.length === 0) {
    current.value = 0;
    setSearchHighlights([], 0);
    updateRings();
    return;
  }
  if (reveal !== false) {
    const first = firstMatchInView(found);
    // Shift+Enter flushes backward: one step BEHIND the first in-view match,
    // wrapping — same as Enter then Shift+Enter on settled results.
    current.value = reveal === 'backward' ? (first - 1 + found.length) % found.length : first;
    revealMatch();
    return;
  }
  // Background re-run: keep the current match where identity survives,
  // otherwise re-pick by viewport (no scrolling).
  const kept =
    anchorNode !== null
      ? found.findIndex((r) => r.startContainer === anchorNode && r.startOffset === anchorOffset)
      : -1;
  current.value = kept >= 0 ? kept : firstMatchInView(found);
  setSearchHighlights(found, current.value);
  updateRings();
}

/** Browser find-in-page semantics: the first match at or below the viewport
 *  top, falling back to the first match overall. A match spanning lines
 *  counts as in view while its LAST line box is still below the pane top —
 *  the first box alone would skip a half-visible match. */
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
  // Re-measure AFTER the reveal: its nested-container scrolls are synchronous
  // and move the match rects without firing a pane scroll event.
  updateRings();
}

function step(delta: number): void {
  if (total.value === 0) return;
  current.value = (current.value + delta + total.value) % total.value;
  revealMatch();
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return;
  // Enter that commits an IME candidate belongs to the input method, not to
  // search navigation (also covers Safari's trailing keydown, keyCode 229).
  if (isComposingKeyEvent(event)) return;
  event.preventDefault();
  // Results still debouncing: establish them and reveal — stepping here
  // would land on the SECOND match. Shift+Enter flushes one step back.
  if (searchTimer !== null) {
    runSearch(event.shiftKey ? 'backward' : 'first');
    return;
  }
  step(event.shiftKey ? -1 : 1);
  // Escape is handled at the container (see template): it must close the find
  // bar no matter which control inside has focus.
}

function onContainerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  // Esc that cancels an IME candidate belongs to the input method — closing
  // the bar (and preventDefault) would fight the IME's own cancel.
  if (isComposingKeyEvent(event)) return;
  // Keep the conversation's Esc-abort (and any app-level dispatcher) out of
  // this keypress: Esc here only closes the find bar.
  event.preventDefault();
  event.stopPropagation();
  emit('close');
}

/** Re-focus + select-all for a repeat Cmd/Ctrl+F while already open. */
function focusInput(): void {
  const el = inputRef.value;
  if (!el) return;
  el.focus();
  el.select();
}
defineExpose({ focusInput });

onMounted(() => {
  void nextTick(() => inputRef.value?.focus());
  // Keep the result set live while the transcript streams or grows: re-run
  // the query on content mutations without re-scrolling. The observer
  // watches the pane (not .chat, which is swapped out on session switches).
  if (props.pane && typeof MutationObserver === 'function') {
    observer = new MutationObserver((mutations) => {
      if (query.value.trim() === '') return;
      if (mutations.every((m) => isIgnorableMutation(m, props.pane))) return;
      // A pending typing debounce owns the next search (runSearch cancels
      // searchTimer) — checked both at arm time and at fire time.
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
    // Attributes too: fold toggles flip inert/style/class without touching
    // childList or text — shown content must become searchable, hidden must
    // leave the result set.
    observer.observe(props.pane, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['inert', 'style', 'class'],
    });
  }
  props.pane?.addEventListener('scroll', onPaneScroll, { passive: true });
  // Re-measure the ring on pane resizes AND content reflows — either moves
  // the match rects without the other noticing.
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
  <!-- Esc closes the bar from ANY control inside (input, nav buttons, close):
       intercepted at the container so the keypress can't bubble to the
       conversation's Esc-abort while a turn is running. -->
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
    <!-- 0fr→1fr grid fold: animates the footer's height without measuring.
         inert while collapsed: the fold is visual-only, so without it the
         nav buttons stay in the tab order and the count keeps announcing. -->
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

    <!-- Current-match outline ring: ::highlight can't paint box outlines, so
         the ring is a real element teleported into the pane. Content
         coordinates — it scrolls along with the transcript. -->
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
  /* One radius for both collapsed and expanded states (no radius morphing);
     20px is a half-height capsule at the 40px shell height. */
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-menu);
  animation: kimi-card-in var(--duration-slow) var(--ease-out);
}
.tsearch.mobile {
  top: var(--space-3);
}
/* Composer-style focus: a neutral hairline overlay fading in while the field
   holds focus (no blue ring) — the same ::after idiom as .composer-card. */
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
  min-height: calc(var(--space-8) + 2 * var(--space-1)); /* 40px — see the capsule note on .tsearch */
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
  outline: none; /* replaced by the composer-style border overlay on .tsearch */
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
/* The close button nests in the pill's rounded end: circular, so its hover
   wash stays concentric with the pill instead of reading as a square tile. */
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

/* Current-match outline ring, teleported into the pane (see template): the
   stroke ::highlight can't paint, in the warning amber so it stays legible
   over the yellow wash in either scheme. The negative margin outsets the
   ring by exactly the stroke width from the JS-measured match rect — one
   --p-findring-w drives both. */
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
