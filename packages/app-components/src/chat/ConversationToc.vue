<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { Card } from '@moonshot-ai/app-ui';
import HistoryWindow from './HistoryWindow.vue';
import VirtualList from './VirtualList.vue';
import { useTranscriptEngine } from '@moonshot-ai/app-client/composables';
import type { ChatTurn } from '@moonshot-ai/app-core/client/types';

export interface ConversationTocItem {
  id: string;
  role: ChatTurn['role'];
  no: number;
  title: string;
}

const props = defineProps<{
  items: ConversationTocItem[];
  sessionId?: string;
  activeTurnId: string | null;
  mobile?: boolean;
  sessionLoading?: boolean;
  tableExpanded?: boolean;
  windowHistory?: boolean;
}>();

const emit = defineEmits<{
  select: [turnId: string];
}>();

const { t } = useI18n();
const listDomId = useId();

function clearPreviewOnBlur(event: FocusEvent): void {
  if (event.relatedTarget instanceof Node && navRef.value?.contains(event.relatedTarget)) return;
  closeDirectory();
}

const RAIL_ROW_HEIGHT = 8;
const DIRECTORY_ROW_HEIGHT = 36;
const DIRECTORY_ROW_GAP = 4;
const EXPANDED_WIDTH = 260;
const MIN_EXPANDED_WIDTH = 160;
const RIGHT_INSET = 12;

const navRef = ref<HTMLElement | null>(null);
const fits = ref(true);
const expandedWidth = ref(EXPANDED_WIDTH);
const expanded = ref(false);
const hoveredId = ref<string | null>(null);
const panelHeight = ref(360);
const railRef = ref<HTMLElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const canScrollUp = ref(false);
const canScrollDown = ref(false);
const railWavePosition = ref<number | null>(null);
const listHistoryRef = ref<{ reveal: (id: string) => Promise<unknown>; release: () => void } | null>(null);
const railHistoryRef = ref<{ reveal: (id: string) => Promise<unknown>; release: () => void } | null>(null);
const directoryEntries = new Map<string, HTMLElement>();
const virtualDirectory = computed(() => props.items.length > 80);
const transcriptV2 = useTranscriptEngine().transcriptEngine.value === 'v2';
const directorySemantics = computed(() => transcriptV2 || !virtualDirectory.value);
function tocItemKey(item: ConversationTocItem): string {
  return item.id;
}
const railList = computed<{ is: Component; props: Record<string, unknown> }>(() => transcriptV2
  ? { is: VirtualList, props: { items: props.items, itemKey: tocItemKey, enabled: props.windowHistory === true, itemSize: RAIL_ROW_HEIGHT, scrollRoot: '.toc-scroll' } }
  : { is: HistoryWindow, props: { scope: 'toc-rail', items: props.items, itemKey: tocItemKey, enabled: props.windowHistory, scrollRoot: '.toc-scroll', estimate: () => RAIL_ROW_HEIGHT, gap: () => 0 } });
const directoryList = computed<{ is: Component; props: Record<string, unknown> }>(() => transcriptV2
  ? { is: VirtualList, props: { items: props.items, itemKey: tocItemKey, enabled: virtualDirectory.value, itemSize: DIRECTORY_ROW_HEIGHT, gap: DIRECTORY_ROW_GAP, scrollRoot: '.toc-list' } }
  : { is: HistoryWindow, props: { scope: 'toc-directory', items: props.items, itemKey: tocItemKey, enabled: virtualDirectory.value, scrollRoot: '.toc-list', estimate: () => 40, gap: (_: ConversationTocItem, index: number) => index ? 4 : 0 } });
let alignmentVersion = 0;
let manualBrowse = false;
let hoverPositioning = false;
let lastRailPointer: { x: number; y: number } | null = null;

function registerEntry(id: string, element: unknown): void {
  if (element instanceof HTMLElement) directoryEntries.set(id, element);
  else directoryEntries.delete(id);
}

function updateScrollEdges(): void {
  const list = listRef.value;
  canScrollUp.value = !!list && list.scrollTop > 1;
  canScrollDown.value = !!list && list.scrollHeight - list.clientHeight - list.scrollTop > 1;
}

function syncRail(): void {
  updateScrollEdges();
  if (hoverPositioning) return;
  const list = listRef.value;
  const rail = railRef.value;
  if (!list || !rail || !directoryEntries.size) return;
  const center = list.getBoundingClientRect().top + list.clientHeight / 2;
  let nearest: { id: string; distance: number; top: number; height: number } | null = null;
  for (const [id, element] of directoryEntries) {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) continue;
    const distance = center < rect.top ? rect.top - center : center > rect.bottom ? center - rect.bottom : 0;
    if (nearest === null || distance < nearest.distance) nearest = { id, distance, top: rect.top, height: rect.height };
  }
  if (!nearest) return;
  const index = itemIndices.value.get(nearest.id);
  if (index === undefined) return;
  const fraction = Math.max(0, Math.min(1, (center - nearest.top) / nearest.height));
  rail.scrollTop = Math.max(0, (index + fraction) * RAIL_ROW_HEIGHT - rail.clientHeight / 2 + 8);
}

async function revealDirectoryItem(id: string | null, version: number): Promise<void> {
  if (!id || !itemIndices.value.has(id)) return;
  await nextTick();
  if (version !== alignmentVersion || !panelVisible.value) return;
  if (virtualDirectory.value) await listHistoryRef.value?.reveal(id);
  if (version !== alignmentVersion || !panelVisible.value) return;
  const list = listRef.value;
  const entry = directoryEntries.get(id);
  if (list && entry) {
    const bounds = list.getBoundingClientRect();
    const rect = entry.getBoundingClientRect();
    list.scrollTop += rect.top - bounds.top - (list.clientHeight - rect.height) / 2;
    syncRail();
  }
  listHistoryRef.value?.release();
}

function beginDirectoryBrowse(): void {
  hoverPositioning = false;
  listHistoryRef.value?.release();
  manualBrowse = true;
  alignmentVersion++;
}

async function scrollFromRail(event: WheelEvent): Promise<void> {
  if (event.ctrlKey || event.deltaY === 0) return;
  event.preventDefault();
  openDirectory();
  beginDirectoryBrowse();
  await nextTick();
  const list = listRef.value;
  if (!list) return;
  const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? list.clientHeight : 1;
  list.scrollTop += event.deltaY * unit;
  syncRail();
}
const panelVisible = computed(() => expanded.value && visible.value && fits.value && !props.tableExpanded);
const itemIndices = computed(() => new Map(props.items.map((item, index) => [item.id, index])));
const hoveredIndex = computed(() => hoveredId.value === null ? -1 : itemIndices.value.get(hoveredId.value) ?? -1);
const wavePosition = computed(() => railWavePosition.value ?? (hoveredIndex.value < 0 ? null : hoveredIndex.value));

function barScale(id: string): number {
  const index = itemIndices.value.get(id);
  if (index === undefined || wavePosition.value === null) return 1;
  const proximity = Math.max(0, 1 - Math.abs(index - wavePosition.value) / 3);
  return 1 + 2.5 * Math.pow(proximity, 1.5);
}

watch([listRef, () => props.items.length, panelHeight], (_, __, onCleanup) => {
  updateScrollEdges();
  const list = listRef.value;
  if (!list || typeof ResizeObserver === 'undefined') return;
  const resizeObserver = new ResizeObserver(updateScrollEdges);
  resizeObserver.observe(list);
  const content = list.querySelector('.history-window, .virtual-list');
  if (content) resizeObserver.observe(content);
  onCleanup(() => resizeObserver.disconnect());
}, { flush: 'post' });

watch(() => props.sessionId, closeDirectory, { immediate: true });

function closeDirectory(): void {
  listHistoryRef.value?.release();
  alignmentVersion++;
  expanded.value = false;
  hoveredId.value = null;
  manualBrowse = false;
  hoverPositioning = false;
  lastRailPointer = null;
  railWavePosition.value = null;
}

function openDirectory(): void {
  if (expanded.value) return;
  expanded.value = true;
  manualBrowse = false;
  void revealDirectoryItem(hoveredId.value ?? props.activeTurnId, ++alignmentVersion);
}

function highlightItem(id: string, event?: MouseEvent): void {
  if (event) {
    if (lastRailPointer?.x === event.clientX && lastRailPointer.y === event.clientY) return;
    lastRailPointer = { x: event.clientX, y: event.clientY };
    const index = itemIndices.value.get(id);
    const row = event.currentTarget;
    if (index !== undefined && row instanceof HTMLElement) {
      const rect = row.getBoundingClientRect();
      const fraction = rect.height > 0 ? Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) - 0.5 : 0;
      railWavePosition.value = index + fraction;
    }
  }
  const unchanged = hoveredId.value === id && hoverPositioning;
  hoveredId.value = id;
  openDirectory();
  hoverPositioning = true;
  manualBrowse = true;
  if (!unchanged) void revealDirectoryItem(id, ++alignmentVersion);
}

function leaveRail(): void {
  hoverPositioning = false;
  lastRailPointer = null;
  railWavePosition.value = null;
}

let observer: ResizeObserver | null = null;

function measure(): void {
  const nav = navRef.value;
  const parent = nav?.offsetParent as HTMLElement | null;
  if (!nav || !parent) return;
  const navLeft = nav.getBoundingClientRect().left;
  const parentRight = parent.getBoundingClientRect().right;
  const availableWidth = parentRight - navLeft - 44 - RIGHT_INSET;
  expandedWidth.value = Math.max(0, Math.min(EXPANDED_WIDTH, availableWidth));
  const chat = parent.querySelector<HTMLElement>('.content-wrap .chat');
  const contentLeft = chat ? chat.getBoundingClientRect().left + (parseFloat(getComputedStyle(chat).paddingLeft) || 0) : parentRight;
  fits.value = availableWidth >= MIN_EXPANDED_WIDTH && navLeft + 44 <= contentLeft;
  const parentHeight = parent.getBoundingClientRect().height;
  panelHeight.value = Math.max(80, Math.min(360, parentHeight - 160, parentHeight * 0.7));
}

const visible = computed(
  () => !props.mobile && !props.sessionLoading && props.items.length > 2,
);

watch(
  visible,
  (isVisible) => {
    observer?.disconnect();
    observer = null;
    if (!isVisible) { closeDirectory(); return; }
    void nextTick(() => {
      const nav = navRef.value;
      const parent = nav?.offsetParent as HTMLElement | null;
      if (!nav || !parent) return;
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(measure);
        observer.observe(parent);
      }
      measure();
    });
  },
  { immediate: true },
);

watch(() => props.activeTurnId, (id) => {
  if (panelVisible.value && !manualBrowse) void revealDirectoryItem(id, ++alignmentVersion);
  if (!panelVisible.value && id) {
    const sessionId = props.sessionId;
    void nextTick(async () => {
      if (panelVisible.value || props.activeTurnId !== id) return;
      if (props.windowHistory) await railHistoryRef.value?.reveal(id);
      if (panelVisible.value || props.activeTurnId !== id || props.sessionId !== sessionId) return;
      const index = itemIndices.value.get(id);
      const rail = railRef.value;
      if (rail && index !== undefined) rail.scrollTop = Math.max(0, (index + 0.5) * RAIL_ROW_HEIGHT - rail.clientHeight / 2 + 8);
      railHistoryRef.value?.release();
    });
  }
}, { immediate: true });

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<template>
  <nav
    v-if="visible"
    ref="navRef"
    class="conversation-toc"
    :class="{ 'toc-clipped': !fits || tableExpanded, expanded: panelVisible }"
    :style="{ '--toc-rail-step': `${RAIL_ROW_HEIGHT}px`, '--toc-expanded-width': `${expandedWidth}px`, '--toc-panel-height': `${panelHeight}px` }"
    :aria-label="t('conversation.toc')"
    :aria-hidden="fits && !tableExpanded ? undefined : true"
    @mouseenter="openDirectory"
    @mouseleave="closeDirectory"
    @focusout="clearPreviewOnBlur"
    @keydown.esc.stop="closeDirectory"
  >
    <div ref="railRef" class="toc-scroll" @wheel="scrollFromRail" @mouseleave="leaveRail">
      <component :is="railList.is" ref="railHistoryRef" :key="String(windowHistory)" v-bind="railList.props">
        <template #default="{ item }: { item: ConversationTocItem }">
          <button
            type="button"
            class="toc-row"
            :class="{
              active: activeTurnId === item.id,
              hovered: hoveredId === item.id,
            }"
            :style="{ '--toc-bar-scale': barScale(item.id) }"
            :aria-label="item.title"
            :aria-controls="panelVisible ? listDomId : undefined"
            :aria-expanded="panelVisible"
            :aria-current="activeTurnId === item.id ? 'location' : undefined"
            @mouseenter="highlightItem(item.id, $event)"
            @mousemove="highlightItem(item.id, $event)"
            @focus="highlightItem(item.id)"
            @click="emit('select', item.id)"
          >
            <span class="toc-bar" />
          </button>
        </template>
      </component>
    </div>
    <Card v-if="panelVisible" :id="listDomId" class="toc-directory" :class="{ 'can-scroll-up': canScrollUp, 'can-scroll-down': canScrollDown }" size="sm">
      <div ref="listRef" class="toc-list" :role="directorySemantics ? 'list' : undefined" @scroll="syncRail" @wheel="beginDirectoryBrowse" @pointerdown="beginDirectoryBrowse" @keydown="beginDirectoryBrowse">
        <component :is="directoryList.is" ref="listHistoryRef" v-bind="directoryList.props">
          <template #default="{ item, index }: { item: ConversationTocItem; index: number }">
        <div
          :ref="element => registerEntry(item.id, element)"
          :role="directorySemantics ? 'listitem' : undefined"
          :aria-posinset="directorySemantics ? index + 1 : undefined"
          :aria-setsize="directorySemantics ? items.length : undefined"
          class="toc-entry"
          :class="{ active: activeTurnId === item.id, hovered: hoveredId === item.id }"
          @mouseenter="hoveredId = item.id"
          @mouseleave="hoveredId = null"
        >
          <button
            type="button"
            class="toc-link"
            :aria-label="item.title"
            :aria-current="activeTurnId === item.id ? 'location' : undefined"
            @focus="hoveredId = item.id"
            @click="emit('select', item.id)"
          ><span class="toc-title">{{ item.title }}</span></button>
        </div>
          </template>
        </component>
      </div>
    </Card>
  </nav>
</template>

<style scoped>
.conversation-toc {
  position: absolute;
  z-index: var(--z-sticky);
  top: 50%;
  left: var(--space-3);
  transform: translateY(-50%);
  width: 44px;
  max-height: min(240px, calc(100% - 160px));
  display: flex;
  flex-direction: column;
}
.toc-scroll {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
  padding: var(--space-2) 0;
}
.toc-scroll::-webkit-scrollbar { display: none; }
.toc-row {
  display: flex;
  align-items: center;
  width: 44px;
  height: var(--toc-rail-step);
  padding: 0 var(--space-2);
  border: none;
  background: transparent;
  cursor: pointer;
}
.toc-row:focus-visible {
  outline: var(--p-focus-ring-w) solid var(--color-accent);
  outline-offset: -2px;
  border-radius: var(--radius-sm);
}
.toc-bar {
  width: 8px;
  height: 2px;
  border-radius: var(--radius-full);
  background: var(--color-line-strong);
  transform: scaleX(var(--toc-bar-scale, 1));
  transform-origin: left center;
  transition: transform var(--duration-fast) var(--ease-out);
}
.expanded .toc-bar { background: var(--color-fill-4); }
.toc-row.hovered .toc-bar,
.toc-row:focus-visible .toc-bar { background: var(--color-accent); }
.toc-row:focus-visible .toc-bar { transform: scaleX(3.5); }
.toc-directory {
  position: absolute;
  top: 50%;
  left: 44px;
  transform: translateY(-50%);
  width: var(--toc-expanded-width);
  box-sizing: border-box;
  background: var(--color-surface-raised);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  animation: toc-directory-in var(--duration-fast) var(--ease-out);
}
@keyframes toc-directory-in {
  from { translate: calc(var(--space-1) * -1) 0; }
  to { translate: 0 0; }
}
.toc-directory::before,
.toc-directory::after {
  content: '';
  position: absolute;
  z-index: 1;
  left: var(--p-hairline);
  right: var(--space-2);
  height: var(--space-4);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.toc-directory::before {
  top: calc(var(--space-2) + var(--p-hairline));
  background: linear-gradient(to bottom, var(--color-surface-raised), transparent);
}
.toc-directory::after {
  bottom: calc(var(--space-2) + var(--p-hairline));
  background: linear-gradient(to top, var(--color-surface-raised), transparent);
}
.toc-directory.can-scroll-up::before,
.toc-directory.can-scroll-down::after { opacity: 1; }
.toc-directory.ui-card :deep(.ui-card__body) {
  padding: var(--space-2) 0;
}
.toc-list {
  box-sizing: border-box;
  max-height: calc(var(--toc-panel-height) - var(--space-2) * 2 - var(--p-hairline) * 2);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  padding: var(--space-1) var(--space-4);
  margin: 0;
}
.toc-entry {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  border-radius: var(--radius-md);
}
.toc-entry + .toc-entry { margin-top: var(--space-1); }
.toc-entry.active,
.toc-entry.hovered { background: var(--color-hover); }
.toc-link {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  height: 36px;
  min-height: 36px;
  padding: var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: none;
  color: inherit;
  font-family: var(--font-ui);
  text-align: left;
  font-weight: var(--weight-regular);
  cursor: pointer;
}
.toc-link:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.toc-title {
  display: block;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--ui-b2);
  line-height: round(calc(var(--ui-b2) * 1.42), 1px);
}
.toc-entry.hovered .toc-link,
.toc-entry .toc-link:hover,
.toc-link:focus-visible { background: var(--color-hover); color: var(--color-accent); }
@media (prefers-reduced-motion: reduce) {
  .toc-bar,
  .toc-directory::before,
  .toc-directory::after { transition: none; }
  .toc-directory { animation: none; }
}
.conversation-toc.toc-clipped {
  visibility: hidden;
  pointer-events: none;
}
</style>
