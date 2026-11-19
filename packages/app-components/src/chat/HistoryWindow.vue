<script setup lang="ts" generic="T">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@moonshot-ai/app-ui';
import { HistoryAllKey, HistoryScrollKey, HistoryStateKey } from '@moonshot-ai/app-core/contracts';
import HistoryRow from './HistoryRow.vue';
import { HistoryHeights } from './historyHeights';

const props = withDefaults(defineProps<{
  items: readonly T[];
  itemKey: (item: T, index: number) => string;
  enabled?: boolean;
  tail?: number;
  overscan?: number;
  estimate?: (item: T, index: number) => number;
  gap?: (item: T, index: number) => number;
  scope?: string;
  state?: Map<string, unknown>;
  scrollRoot?: string;
}>(), { enabled: false, tail: 1, overscan: 1, scope: 'items', scrollRoot: '.panes' });
const adjustScroll = inject(HistoryScrollKey, (container: HTMLElement, delta: number) => { container.scrollTop += delta; });
const renderAll = inject(HistoryAllKey, undefined);
const { t } = useI18n();
const parentState = props.state ?? inject(HistoryStateKey, undefined);
const nested = !props.state && parentState !== undefined;
type HistoryRecord = { height: number; fontScale: string; state: Map<string, unknown>; est?: number };
const saved = parentState?.get(`window:${props.scope}`) as Map<string, HistoryRecord> | undefined;
const records = saved ?? new Map<string, HistoryRecord>();
if (props.state) parentState?.delete(`window:${props.scope}`);
parentState?.set(`window:${props.scope}`, records);
if (props.state && parentState) while (parentState.size > 4) parentState.delete(parentState.keys().next().value!);
const root = ref<HTMLElement | null>(null);
const rows = new Map<string, HTMLElement>();
const positions = new Map<string, number>();
const heights = new HistoryHeights();
const version = ref(0);
const viewport = shallowRef({ top: 0, bottom: 0 });
const protectedKeys = shallowRef(new Set<string>());
const requested = ref<string | null>(null);
const ready = ref(false);
let scroller: HTMLElement | null = null;
let observer: ResizeObserver | null = null;
let fontObserver: MutationObserver | null = null;
let frame = 0;
let resizeFrame = 0;
let scrollerSize: { width: number; height: number } | null = null;
let scrollerResized = false;
let settled = false;
let disposed = false;

const keys = computed(() => props.items.map(props.itemKey));
function estimate(index: number): number { return Math.max(1, props.estimate?.(props.items[index]!, index) ?? 100); }
function fontScale(): string { return document.documentElement.dataset.fontScale ?? 'medium'; }
let pendingAnchor: { key: string; top: number; estimated: number } | null = null;
let settlingAnchor = false;
function findAnchor(previous: readonly string[], next: readonly string[]): { key: string; top: number } | null {
  const surviving = new Set(next);
  const start = Math.min(heights.at(Math.max(0, viewport.value.top)), previous.length - 1);
  for (let i = start; i < previous.length; i++) {
    const key = previous[i]!;
    if (surviving.has(key)) return { key, top: heights.top(i) };
  }
  return null;
}

watch(() => props.enabled ? keys.value : [], (next, previous) => {
  if (previous?.length === next.length && next.every((key, i) => key === previous[i])) return;
  const anchor = previous?.length ? findAnchor(previous, next) : null;
  positions.clear();
  next.forEach((key, i) => {
    positions.set(key, i);
    const est = estimate(i);
    const record = records.get(key);
    if (!record) records.set(key, { height: est, fontScale: fontScale(), state: new Map(), est });
    else if (record.fontScale !== fontScale() || record.est === undefined || (record.height === record.est && record.est !== est)) {
      record.height = est;
      record.est = est;
    }
  });
  for (const key of records.keys()) if (!positions.has(key)) records.delete(key);
  heights.reset(next.map(key => records.get(key)!.height));
  if (anchor) {
    const delta = heights.top(positions.get(anchor.key)!) - anchor.top;
    if (delta) {
      viewport.value = { top: viewport.value.top + delta, bottom: viewport.value.bottom + delta };
      if (pendingAnchor && positions.has(pendingAnchor.key)) pendingAnchor.estimated += delta;
      else pendingAnchor = { key: anchor.key, top: anchor.top, estimated: delta };
      if (!settlingAnchor) {
        settlingAnchor = true;
        void nextTick(settleAnchor);
      }
    }
  }
  version.value++;
}, { immediate: true });

let lastRootOffset = 0;
function rootOffset(): number {
  return root.value!.getBoundingClientRect().top - scroller!.getBoundingClientRect().top + scroller!.scrollTop;
}

function rootShift(): number {
  if (nested) return 0;
  const offset = rootOffset();
  const shift = offset - lastRootOffset;
  lastRootOffset = offset;
  return shift;
}

async function settleAnchor(): Promise<void> {
  try {
    const pending = pendingAnchor;
    if (!pending || !scroller || !root.value || disposed) {
      pendingAnchor = null;
      return;
    }
    for (let pass = 0; pass < 4; pass++) {
      const before = new Set(rows.keys());
      measureRows([...rows.values()]);
      const index = positions.get(pending.key);
      const rowDelta = index === undefined ? pending.estimated : heights.top(index) - pending.top;
      const correction = rowDelta - pending.estimated;
      if (correction) {
        viewport.value = { top: viewport.value.top + correction, bottom: viewport.value.bottom + correction };
        pending.estimated = rowDelta;
      }
      version.value++;
      if (!correction) break;
      await nextTick();
      if (disposed || !scroller || !root.value || pendingAnchor !== pending) return;
      let added = false;
      for (const key of rows.keys()) {
        if (!before.has(key)) {
          added = true;
          break;
        }
      }
      if (!added) break;
    }
    const index = positions.get(pending.key);
    const rowDelta = index === undefined ? pending.estimated : heights.top(index) - pending.top;
    const delta = rowDelta + rootShift();
    pendingAnchor = null;
    if (delta) adjustScroll(scroller, delta);
  } finally {
    settlingAnchor = false;
    if (pendingAnchor && !disposed) {
      settlingAnchor = true;
      void nextTick(settleAnchor);
    }
  }
}

function measureRows(elements: Element[]): boolean {
  let changed = false;
  for (const element of elements) {
    const el = element as HTMLElement;
    if (el === root.value || el === scroller) continue;
    const key = el.dataset.historyKey;
    const record = key === undefined ? undefined : records.get(key);
    const index = key === undefined ? undefined : positions.get(key);
    const height = el.getBoundingClientRect().height;
    if (record && index !== undefined && height > 0 && Math.abs(record.height - height) > 0.25) {
      record.height = height;
      heights.set(index, height);
      changed = true;
    }
  }
  return changed;
}

function measureViewport(): void {
  frame = 0;
  if (!scroller || !root.value || disposed) return;
  protectInteraction();
  const top = scroller.getBoundingClientRect().top - root.value.getBoundingClientRect().top;
  viewport.value = { top, bottom: top + scroller.clientHeight };
  ready.value = true;
}

function schedule(): void {
  if (!frame && !disposed) frame = requestAnimationFrame(measureViewport);
}

function refreshInteraction(): void { queueMicrotask(protectInteraction); }

function protectInteraction(): void {
  const next = new Set<string>();
  const selection = document.getSelection();
  const active = document.activeElement;
  for (const [key, el] of rows) {
    if (el.contains(active)) next.add(key);
    if (selection && !selection.isCollapsed) {
      for (const endpoint of [selection.anchorNode, selection.focusNode]) {
        let node = endpoint;
        while (node) {
          if (el.contains(node)) next.add(key);
          const tree = node.getRootNode();
          node = tree instanceof ShadowRoot ? tree.host : null;
        }
      }
      for (let i = 0; i < selection.rangeCount; i++) {
        if (selection.getRangeAt(i).intersectsNode(el)) next.add(key);
      }
    }
  }
  if (next.size !== protectedKeys.value.size || [...next].some(key => !protectedKeys.value.has(key))) protectedKeys.value = next;
}

const totalHeight = computed(() => { void version.value; return heights.top(keys.value.length); });

type HistoryEntry = { key: string; index: number; space: number };
type HistorySlot = { key: string; index: number; spaced: boolean };
const layout = computed<HistoryEntry[]>((previous) => {
  void version.value;
  const n = keys.value.length;
  if (!n) return [];
  const chosen = new Set<number>();
  if (renderAll?.value) {
    for (let i = 0; i < n; i++) chosen.add(i);
  } else if (ready.value) {
    const padding = Math.max(400, (viewport.value.bottom - viewport.value.top) * props.overscan);
    const first = heights.at(Math.max(0, viewport.value.top - padding));
    const last = heights.at(Math.max(0, viewport.value.bottom + padding));
    for (let i = first; i <= last; i++) chosen.add(i);
  }
  for (let i = Math.max(0, n - props.tail); i < n; i++) chosen.add(i);
  for (const key of protectedKeys.value) {
    const index = positions.get(key);
    if (index !== undefined) chosen.add(index);
  }
  if (requested.value !== null) {
    const index = positions.get(requested.value);
    if (index !== undefined) chosen.add(index);
  }
  const result: HistoryEntry[] = [];
  let end = 0;
  for (const index of [...chosen].sort((a, b) => a - b)) {
    result.push({ key: keys.value[index]!, index, space: heights.top(index) - heights.top(end) });
    end = index + 1;
  }
  if (end < n) result.push({ key: 'remaining-space', index: -1, space: heights.top(n) - heights.top(end) });
  return previous?.length === result.length && result.every((entry, i) => entry.key === previous[i]!.key && entry.index === previous[i]!.index && entry.space === previous[i]!.space) ? previous : result;
});

const entries = computed<HistorySlot[]>((previous) => {
  const result = layout.value.map(entry => ({ key: entry.key, index: entry.index, spaced: entry.space > 0 }));
  return previous?.length === result.length && result.every((entry, i) => entry.key === previous[i]!.key && entry.index === previous[i]!.index && entry.spaced === previous[i]!.spaced) ? previous : result;
});

const spacers = new Map<string, HTMLElement>();
function registerSpace(key: string, value: unknown): void {
  if (value instanceof HTMLElement) spacers.set(key, value);
  else spacers.delete(key);
}

watchEffect(() => {
  for (const entry of layout.value) {
    const spacer = spacers.get(entry.key);
    if (spacer) spacer.style.height = `${entry.space}px`;
  }
}, { flush: 'post' });

watchEffect(() => {
  const el = root.value;
  if (el && !nested) el.style.minHeight = `${totalHeight.value}px`;
}, { flush: 'post' });

function register(key: string, value: unknown): void {
  const old = rows.get(key);
  const el = value && typeof value === 'object' && '$el' in value ? value.$el : value;
  if (old === el) return;
  if (old) observer?.unobserve(old);
  if (el instanceof HTMLElement) {
    rows.set(key, el);
    observer?.observe(el, { box: 'border-box' });
  } else rows.delete(key);
}

async function reveal(key: string): Promise<HTMLElement | null> {
  const index = positions.get(key);
  if (index === undefined || !root.value) return null;
  protectInteraction();
  requested.value = key;
  await nextTick();
  if (scroller) {
    const top = root.value.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = top + heights.top(index);
    measureViewport();
  }
  await nextTick();
  return rows.get(key) ?? null;
}

function release(): void { requested.value = null; }

async function navigate(index: number): Promise<void> {
  const key = keys.value[index];
  if (key === undefined) return;
  const row = await reveal(key);
  if (disposed || requested.value !== key || !row?.isConnected) return;
  row.focus({ preventScroll: true });
  protectInteraction();
}

onMounted(() => {
  scroller = root.value?.closest<HTMLElement>(props.scrollRoot) ?? null;
  if (!scroller || !props.enabled) return;
  const applySizes = (elements: Element[], resetFont = false) => {
    const anchorIndex = viewport.value.top >= 0 && viewport.value.top < heights.top(keys.value.length)
      ? heights.at(viewport.value.top) : undefined;
    const before = anchorIndex === undefined ? 0 : heights.top(anchorIndex);
    let changed = false;
    if (resetFont) {
      const scale = fontScale();
      const samples = new Map<number, number[]>();
      for (const [key, el] of rows) {
        const index = positions.get(key);
        const height = el.getBoundingClientRect().height;
        if (index === undefined || height <= 0) continue;
        const size = estimate(index);
        const group = samples.get(size) ?? [];
        group.push(height - (props.gap?.(props.items[index]!, index) ?? 0));
        samples.set(size, group);
      }
      const estimates = new Map([...samples].map(([size, group]) => [size, group.sort((a, b) => a - b)[Math.floor(group.length / 2)]!]));
      for (const [key, record] of records) {
        if (record.fontScale === scale) continue;
        record.fontScale = scale;
        const index = positions.get(key)!;
        const size = estimate(index);
        const measured = estimates.get(size);
        record.height = measured === undefined ? size : Math.max(1, measured + (props.gap?.(props.items[index]!, index) ?? 0));
        heights.set(index, record.height);
        changed = true;
      }
    }
    if (measureRows(elements)) changed = true;
    if (changed) {
      version.value++;
      if (anchorIndex !== undefined && viewport.value.top > 0) {
        const delta = heights.top(anchorIndex) - before;
        viewport.value = { top: viewport.value.top + delta, bottom: viewport.value.bottom + delta };
        adjustScroll(scroller!, delta);
      }
    }
    schedule();
  };
  const settleSizes = (elements: Element[], releaseHeight: boolean) => {
    const shift = rootShift();
    const top = scroller!.getBoundingClientRect().top - root.value!.getBoundingClientRect().top;
    const anchorIndex = top > 0 && top < heights.top(keys.value.length) ? heights.at(top) : undefined;
    const before = anchorIndex === undefined ? 0 : heights.top(anchorIndex);
    let delta = shift;
    if (measureRows(elements)) {
      settled = true;
      if (releaseHeight && !nested) root.value!.style.minHeight = `${heights.top(keys.value.length)}px`;
      if (anchorIndex !== undefined) delta += heights.top(anchorIndex) - before;
    }
    if (delta) adjustScroll(scroller!, delta);
  };
  const flushResizes = () => {
    resizeFrame = 0;
    scrollerResized = false;
    if (settled) {
      settled = false;
      version.value++;
    }
    measureViewport();
  };
  observer = new ResizeObserver(changes => {
    const own = changes.find(change => change.target === scroller);
    if (own) {
      const { width, height } = own.contentRect;
      if (scrollerSize && (scrollerSize.width !== width || scrollerSize.height !== height)) scrollerResized = true;
      scrollerSize = { width, height };
    }
    settleSizes(changes.map(change => change.target), scrollerResized && own !== undefined);
    if (!resizeFrame) resizeFrame = requestAnimationFrame(flushResizes);
  });
  observer.observe(root.value!);
  observer.observe(scroller);
  if (!nested && root.value!.parentElement) observer.observe(root.value!.parentElement);
  for (const el of rows.values()) observer.observe(el, { box: 'border-box' });
  lastRootOffset = rootOffset();
  applySizes([...rows.values()], true);
  fontObserver = new MutationObserver(() => applySizes([...rows.values()], true));
  fontObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-font-scale'] });
  scroller.addEventListener('scroll', schedule, { passive: true });
  scroller.addEventListener('wheel', release, { passive: true });
  scroller.addEventListener('touchstart', release, { passive: true });
  document.addEventListener('selectionchange', protectInteraction);
  document.addEventListener('focusin', refreshInteraction, true);
  document.addEventListener('focusout', refreshInteraction, true);
  measureViewport();
});

onBeforeUnmount(() => {
  disposed = true;
  if (frame) cancelAnimationFrame(frame);
  if (resizeFrame) cancelAnimationFrame(resizeFrame);
  observer?.disconnect();
  fontObserver?.disconnect();
  scroller?.removeEventListener('scroll', schedule);
  scroller?.removeEventListener('wheel', release);
  scroller?.removeEventListener('touchstart', release);
  document.removeEventListener('selectionchange', protectInteraction);
  document.removeEventListener('focusin', refreshInteraction, true);
  document.removeEventListener('focusout', refreshInteraction, true);
});
defineExpose({ reveal, release });
</script>

<template>
  <template v-if="!enabled"><slot v-for="(item, index) in items" :key="itemKey(item, index)" :item="item" :index="index" /></template>
  <div v-else ref="root" class="history-window" data-virtual-scroll-root role="list">
    <template v-for="entry in entries" :key="entry.key">
      <div v-if="entry.spaced" :ref="el => registerSpace(entry.key, el)" aria-hidden="true" class="history-space" />
      <HistoryRow v-if="entry.index >= 0" :ref="el => register(entry.key, el)" :state="records.get(entry.key)!.state" :data-history-key="entry.key" role="listitem" :aria-posinset="entry.index + 1" :aria-setsize="items.length" tabindex="-1" :style="`padding-top: ${gap?.(items[entry.index]!, entry.index) ?? 0}px`">
        <Button v-if="!renderAll && entry.index > 0" class="history-navigation history-previous" variant="secondary" size="xs" @click="navigate(entry.index - 1)">{{ t('conversation.historyPrevious') }}</Button>
        <slot :item="items[entry.index]!" :index="entry.index" />
        <Button v-if="!renderAll && entry.index < items.length - 1" class="history-navigation history-next" variant="secondary" size="xs" @click="navigate(entry.index + 1)">{{ t('conversation.historyNext') }}</Button>
      </HistoryRow>
    </template>
  </div>
</template>

<style scoped>
.history-window { min-width: 0; flex-shrink: 0; overflow-anchor: none; }
.history-space { pointer-events: none; overflow-anchor: none; }
.history-row { position: relative; }
.history-row:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.history-navigation { position: absolute; inset-inline-start: var(--space-1); z-index: var(--z-raised); user-select: none; }
.history-previous { top: var(--space-1); }
.history-next { bottom: var(--space-1); }
.history-navigation:not(:focus) { width: 1px; height: 1px; padding: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
