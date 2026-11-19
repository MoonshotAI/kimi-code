<script setup lang="ts" generic="T">
import { inject, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@moonshot-ai/app-ui';
import { TranscriptFlatKey, TranscriptScrollKey, type TranscriptListHandle, type TranscriptRefreshSource } from '@moonshot-ai/app-core/contracts';
import type { AnchorPath } from '@moonshot-ai/app-core/lib';
import HistoryRow from './HistoryRow.vue';

const props = withDefaults(defineProps<{
  items: readonly T[];
  itemKey: (item: T, index: number) => string;
  scope: string;
  state?: Map<string, unknown>;
  estimate?: (item: T, index: number) => number;
  kind?: (item: T, index: number) => string;
  tail?: number;
  overscan?: number;
  renderAll?: boolean;
}>(), { tail: 2, overscan: 1.5, renderAll: false });

type Slot = { key: string; index: number; gapBefore: boolean };
type View = { slots: Slot[]; trailing: boolean };

const ROW_STATE_SCOPES = 4;
const TOUCH_OVERSCAN = 3;
const MIN_OVERSCAN_PX = 400;
const MAX_CASCADE = 8;

const { t } = useI18n();
const host = inject(TranscriptScrollKey, null);
provide(TranscriptFlatKey, true);

const stateKey = `transcript:${props.scope}`;
const rowStates = (props.state?.get(stateKey) as Map<string, Map<string, unknown>> | undefined) ?? new Map<string, Map<string, unknown>>();
if (props.state) {
  props.state.delete(stateKey);
  props.state.set(stateKey, rowStates);
  while (props.state.size > ROW_STATE_SCOPES) props.state.delete(props.state.keys().next().value!);
}

const root = ref<HTMLElement | null>(null);
const measure = ref<HTMLElement | null>(null);
const rows = new Map<string, HTMLElement>();
const fresh = new Set<string>();
const spacers = new Map<string, HTMLElement>();
const interaction = shallowRef(new Set<string>());
const requested = ref<string | null>(null);
const modelRevision = ref(0);
let keys: string[] = [];
let deferredFrame = 0;
let cascade = 0;
let cascadeReset = false;
let disposed = false;
let detach: (() => void) | null = null;

function rowState(key: string): Map<string, unknown> {
  let state = rowStates.get(key);
  if (!state) rowStates.set(key, (state = new Map()));
  return state;
}

function syncModel(): boolean {
  const next = props.items.map(props.itemKey);
  if (host) host.model.setScope(props.scope);
  if (next.length === keys.length && next.every((key, i) => key === keys[i]) && host?.model.length === next.length) return false;
  keys = next;
  const present = new Set(next);
  for (const key of rowStates.keys()) if (!present.has(key)) rowStates.delete(key);
  host?.model.setRows(props.items.map((item, index) => ({
    key: next[index]!,
    estimate: Math.max(1, props.estimate?.(item, index) ?? 100),
    kind: props.kind?.(item, index),
  })));
  modelRevision.value++;
  return true;
}

function allRows(): View {
  return { slots: keys.map((key, index) => ({ key, index, gapBefore: false })), trailing: false };
}

function viewportHeight(): number {
  return host?.scroller.value?.clientHeight || (typeof window === 'undefined' ? 800 : window.innerHeight);
}

function domTop(): number | null {
  const scroller = host?.scroller.value;
  const list = root.value;
  if (!scroller || !list || !list.isConnected) return null;
  return scroller.getBoundingClientRect().top - list.getBoundingClientRect().top;
}

function modelViewTop(): number | null {
  const scroller = host?.scroller.value;
  if (!host || !scroller) return null;
  const top = scroller.getBoundingClientRect().top;
  let last: { index: number; el: HTMLElement } | null = null;
  for (const slot of view.value.slots) {
    const el = rows.get(slot.key);
    if (!el?.isConnected) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom > top) return host.model.top(slot.index) + top - rect.top;
    last = { index: slot.index, el };
  }
  if (!last) return domTop();
  return host.model.top(last.index + 1) + top - last.el.getBoundingClientRect().bottom;
}

function anchorTop(anchor: AnchorPath, offset: number): number | null {
  const model = host!.model;
  const index = model.indexOf(anchor.row);
  if (index === undefined) return null;
  let within = 0;
  const row = rows.get(anchor.row);
  if (row?.isConnected) {
    const el = host!.resolveAnchor(anchor);
    if (el) within = el.getBoundingClientRect().top - row.getBoundingClientRect().top;
  }
  return model.top(index) + within - offset;
}

function computeView(source: TranscriptRefreshSource): View {
  if (!host || props.renderAll || keys.length === 0) return allRows();
  const model = host.model;
  const viewport = viewportHeight();
  const overscanPx = Math.max(MIN_OVERSCAN_PX, viewport * (host.touch() ? TOUCH_OVERSCAN : props.overscan));
  const mode = host.controller.value?.state.mode ?? { kind: 'follow' as const };
  const keep = new Set(interaction.value);
  if (requested.value !== null) keep.add(requested.value);
  const scrolled = source === 'scroll' ? modelViewTop() : null;
  let top: number;
  if (mode.kind === 'follow') {
    const bottom = Math.max(0, model.total() - viewport);
    top = bottom;
    if (scrolled !== null && Math.abs(scrolled - bottom) > viewport) {
      for (let i = model.indexAt(Math.max(0, bottom - overscanPx)); i < model.length; i++) keep.add(model.keyAt(i)!);
      top = scrolled;
    }
  } else if (mode.kind === 'anchored') {
    keep.add(mode.anchor.row);
    top = scrolled ?? anchorTop(mode.anchor, mode.offset) ?? domTop() ?? 0;
  } else {
    keep.add(mode.target.row);
    const index = model.indexOf(mode.target.row);
    top = scrolled ?? (index === undefined ? domTop() ?? 0 : model.top(index) - viewport / 2);
  }
  const range = model.range(top, top + viewport, { overscanPx, tail: props.tail, protected: keep });
  let end = 0;
  const slots = range.rows.map(row => {
    const slot = { key: row.key, index: row.index, gapBefore: row.index > end };
    end = row.index + 1;
    return slot;
  });
  return { slots, trailing: end < model.length };
}

function sameView(a: View, b: View): boolean {
  return a.trailing === b.trailing && a.slots.length === b.slots.length &&
    a.slots.every((slot, i) => slot.key === b.slots[i]!.key && slot.index === b.slots[i]!.index && slot.gapBefore === b.slots[i]!.gapBefore);
}

syncModel();
const view = shallowRef<View>(computeView('model'));

function holdHeight(): void {
  const list = root.value;
  if (!host || !list) return;
  list.style.minHeight = `${Math.max(host.model.total(), list.getBoundingClientRect().height)}px`;
}

function setView(next: View): void {
  if (sameView(next, view.value)) return;
  holdHeight();
  view.value = next;
  writeSpacers();
}

function refresh(source: TranscriptRefreshSource, defer = false): void {
  if (disposed) return;
  if (!defer && ++cascade > MAX_CASCADE) defer = true;
  if (!cascadeReset) {
    cascadeReset = true;
    requestAnimationFrame(() => {
      cascade = 0;
      cascadeReset = false;
    });
  }
  if (defer) {
    if (!deferredFrame) {
      deferredFrame = requestAnimationFrame(() => {
        deferredFrame = 0;
        refresh('scroll');
        writeSpacers();
      });
    }
    return;
  }
  setView(computeView(source));
}

function setHeight(el: HTMLElement | undefined, height: number): boolean {
  if (!el) return false;
  const value = `${Math.max(0, height)}px`;
  if (el.style.height === value) return false;
  el.style.height = value;
  return true;
}

function spacerHeights(): Map<string, number> {
  const heights = new Map<string, number>();
  if (!host) return heights;
  const model = host.model;
  let end = 0;
  for (const slot of view.value.slots) {
    if (slot.gapBefore) heights.set(slot.key, model.top(slot.index) - model.top(end));
    end = slot.index + 1;
  }
  if (view.value.trailing) heights.set('', model.total() - model.top(end));
  return heights;
}

function spacersStale(): boolean {
  for (const [key, height] of spacerHeights()) {
    const el = spacers.get(key);
    if (el && el.style.height !== `${Math.max(0, height)}px`) return true;
  }
  return false;
}

function writeSpacers(): void {
  for (const [key, height] of spacerHeights()) setHeight(spacers.get(key), height);
}

function registerSpacer(key: string, value: unknown): void {
  if (!(value instanceof HTMLElement)) {
    spacers.delete(key);
    return;
  }
  if (spacers.get(key) === value) return;
  spacers.set(key, value);
  const height = spacerHeights().get(key);
  if (height !== undefined) setHeight(value, height);
}

function registerRow(key: string, value: unknown): void {
  const el = value && typeof value === 'object' && '$el' in value ? value.$el : value;
  const previous = rows.get(key);
  if (el instanceof HTMLElement) {
    if (previous === el) return;
    rows.set(key, el);
    fresh.add(key);
    host?.observeRow(key, el);
  } else if (previous) {
    rows.delete(key);
    fresh.delete(key);
    host?.observeRow(key, null);
  }
}

watch(() => props.items, () => {
  if (!syncModel()) return;
  holdHeight();
  setView(computeView('model'));
  writeSpacers();
});

watch(() => props.items, () => {
  if (host?.controller.value?.state.mode.kind === 'follow') host.sync();
}, { flush: 'post' });

watch(() => props.renderAll, () => refresh('scroll'));

function measureFresh(): void {
  if (!host || !fresh.size) return;
  for (const key of fresh) {
    const el = rows.get(key);
    if (el?.isConnected) host.model.measure(key, el.getBoundingClientRect().height);
  }
  fresh.clear();
  host.model.refreshEstimates();
}

watch([view, modelRevision], () => {
  measureFresh();
  writeSpacers();
  if (root.value) root.value.style.minHeight = '';
  const next = computeView('model');
  if (!sameView(next, view.value) && ++cascade <= MAX_CASCADE) {
    setView(next);
    return;
  }
  host?.sync();
}, { flush: 'post' });

function protectInteraction(): void {
  const next = new Set<string>();
  const selection = document.getSelection();
  const active = document.activeElement;
  for (const [key, el] of rows) {
    if (active && el.contains(active)) next.add(key);
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
  const previous = interaction.value;
  if (next.size === previous.size && [...next].every(key => previous.has(key))) return;
  interaction.value = next;
  refresh('scroll');
}

function refreshInteraction(): void {
  queueMicrotask(protectInteraction);
}

async function reveal(key: string): Promise<HTMLElement | null> {
  if (!host || host.model.indexOf(key) === undefined) return null;
  requested.value = key;
  refresh('scroll');
  await host.navigate({ row: key }, { align: 'start' });
  return rows.get(key) ?? null;
}

function release(): void {
  requested.value = null;
}

async function navigateTo(index: number): Promise<void> {
  const key = keys[index];
  if (key === undefined) return;
  const row = await reveal(key);
  if (disposed || requested.value !== key || !row?.isConnected) return;
  row.focus({ preventScroll: true });
  protectInteraction();
  release();
}

const handle: TranscriptListHandle = {
  get root() {
    return root.value!;
  },
  applyLayout() {
    if (!sameView(computeView('model'), view.value) || spacersStale()) refresh('scroll', true);
  },
  refresh,
};

onMounted(() => {
  writeSpacers();
  host?.observeAux('content', measure.value);
  host?.observeAux('tail', root.value, 'list');
  detach = host?.attachList(handle) ?? null;
  document.addEventListener('selectionchange', protectInteraction);
  document.addEventListener('focusin', refreshInteraction, true);
  document.addEventListener('focusout', refreshInteraction, true);
});

onBeforeUnmount(() => {
  disposed = true;
  if (deferredFrame) cancelAnimationFrame(deferredFrame);
  detach?.();
  detach = null;
  host?.observeAux('tail', null, 'list');
  document.removeEventListener('selectionchange', protectInteraction);
  document.removeEventListener('focusin', refreshInteraction, true);
  document.removeEventListener('focusout', refreshInteraction, true);
});

defineExpose({ reveal, release });
</script>

<template>
  <div ref="root" class="transcript-list" role="list">
    <div ref="measure" class="transcript-measure" aria-hidden="true" />
    <template v-for="slot in view.slots" :key="slot.key">
      <div v-if="slot.gapBefore" :ref="el => registerSpacer(slot.key, el)" class="transcript-space" aria-hidden="true" />
      <HistoryRow :ref="el => registerRow(slot.key, el)" :state="rowState(slot.key)" :data-row-key="slot.key" role="listitem" :aria-posinset="slot.index + 1" :aria-setsize="items.length" tabindex="-1">
        <Button v-if="!renderAll && slot.index > 0" class="history-navigation history-previous" variant="secondary" size="xs" @click="navigateTo(slot.index - 1)">{{ t('conversation.historyPrevious') }}</Button>
        <slot :item="items[slot.index]!" :index="slot.index" />
        <Button v-if="!renderAll && slot.index < items.length - 1" class="history-navigation history-next" variant="secondary" size="xs" @click="navigateTo(slot.index + 1)">{{ t('conversation.historyNext') }}</Button>
      </HistoryRow>
    </template>
    <div v-if="view.trailing" :ref="el => registerSpacer('', el)" class="transcript-space" aria-hidden="true" />
  </div>
</template>

<style scoped>
.transcript-list { min-width: 0; flex-shrink: 0; overflow-anchor: none; }
.transcript-measure { height: 0; overflow: hidden; }
.transcript-space { pointer-events: none; overflow-anchor: none; }
.history-row { position: relative; }
.history-row:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.history-navigation { position: absolute; inset-inline-start: var(--space-1); z-index: var(--z-raised); user-select: none; }
.history-previous { top: var(--space-1); }
.history-next { bottom: var(--space-1); }
.history-navigation:not(:focus) { width: 1px; height: 1px; padding: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
