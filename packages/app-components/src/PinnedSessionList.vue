<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PinnedEntry, Session } from '@moonshot-ai/app-core/client/types';
import type { DropPosition, PinnedInsertTarget, SessionListRowMeasure } from '@moonshot-ai/app-core/lib';
import {
  loadPinnedCollapsed,
  isNoopGesture,
  measureSessionsListRows,
  pinnedRowsDefaultHeight,
  pinnedRowsKeyboardTarget,
  pinnedRowsMaxHeight,
  pinnedRowsMinHeight,
  pinnedRowsResizeCeiling,
  pinnedSectionResizable,
  pinnedSessionKey,
  safeGetString,
  savePinnedCollapsed,
  sessionsListMinHeight,
  STORAGE_KEYS,
} from '@moonshot-ai/app-core/lib';
import { useAppearance } from '@moonshot-ai/app-core';
import { useResizable, useOverlayScrollbar } from '@moonshot-ai/app-client/composables';
import SessionRow from './SessionRow.vue';
import { useSessionDrag, usePinnedListDrag } from './composables/useSessionDrag';
import { Icon, IconButton } from '@moonshot-ai/app-ui';

const { t } = useI18n();

const props = defineProps<{
  sessions: Session[];
  entries?: PinnedEntry[];
  pinnedWorkspaceIds?: readonly string[];
  workspaceRowCount?: number;
  activeId: string;
  pendingBySession: Record<string, { approvals: number; questions: number }>;
  unreadBySession: Record<string, boolean>;
  stateTag?: 'open' | 'done';
  flashSessionId?: string | null;
  flashWorkspaceId?: string | null;
}>();

const emit = defineEmits<{
  selectSession: [sessionId: string];
  renameSession: [id: string, title: string];
  generateSessionTitle: [id: string, done: (title: string | null) => void];
  archiveSession: [id: string];
  deleteSession: [id: string];
  forkSession: [id: string];
  exportSession: [id: string];
  pinSession: [id: string];
  reloadSession: [id: string];
  dropPin: [id: string, target?: PinnedInsertTarget];
  dropPinWorkspace: [workspaceId: string, target?: PinnedInsertTarget];
  reorderPinned: [fromKey: string, toKey: string, position: DropPosition];
}>();

const collapsed = ref(loadPinnedCollapsed());

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value;
  savePinnedCollapsed(collapsed.value);
}

function expand(): void {
  if (!collapsed.value) return;
  collapsed.value = false;
  savePinnedCollapsed(false);
}
defineExpose({ expand });

const resizable = computed(
  () => !collapsed.value && pinnedSectionResizable(props.sessions.length + (props.workspaceRowCount ?? 0)),
);

const viewportHeight = ref(window.innerHeight);

function onWindowResize(): void {
  viewportHeight.value = window.innerHeight;
}

onMounted(() => window.addEventListener('resize', onWindowResize));
onBeforeUnmount(() => window.removeEventListener('resize', onWindowResize));

const pinnedRootEl = ref<HTMLElement | null>(null);
const pinnedRowsEl = ref<HTMLElement | null>(null);

function sessionsListEl(): HTMLElement | null {
  return (pinnedRootEl.value?.parentElement?.nextElementSibling as HTMLElement | null) ?? null;
}

const splitBudget = ref<number | undefined>(undefined);

function measureSplitBudget(): void {
  const rows = pinnedRowsEl.value;
  const sessions = sessionsListEl();
  if (!rows || !sessions) {
    splitBudget.value = undefined;
    return;
  }
  splitBudget.value = rows.getBoundingClientRect().height + sessions.getBoundingClientRect().height;
}

const sessionRowHeight = ref<number | null>(null);
const sessionsRowSpan = ref<number | null>(null);
const sessionsPaddingY = ref<number | null>(null);

function measureSessionList(): void {
  const sessions = sessionsListEl();
  if (!sessions) return;
  const rows = sessions.querySelectorAll('.se');
  const measures: SessionListRowMeasure[] = [];
  let visibleCount = 0;
  for (let i = 0; i < rows.length && visibleCount < 3; i++) {
    const row = rows.item(i) as HTMLElement;
    if (row.closest('.group-sessions.collapsed') !== null) {
      measures.push({ visible: false, height: 0, viewportBottom: 0 });
      continue;
    }
    visibleCount += 1;
    const rect = row.getBoundingClientRect();
    measures.push({ visible: true, height: rect.height, viewportBottom: rect.bottom });
  }
  const measured = measureSessionsListRows(measures, sessions.getBoundingClientRect().top, sessions.scrollTop);
  if (measured.firstRowHeight !== null) sessionRowHeight.value = measured.firstRowHeight;
  sessionsRowSpan.value = measured.spanToThirdRow;
  const pad = Number.parseFloat(globalThis.getComputedStyle(sessions).paddingBottom);
  sessionsPaddingY.value = Number.isFinite(pad) ? pad : null;
}

let budgetObserver: ResizeObserver | null = null;
let sessionsMutationObserver: MutationObserver | null = null;

function onSessionsTransitionEnd(event: TransitionEvent): void {
  if (event.propertyName !== 'height') return;
  if (!(event.target as HTMLElement).classList.contains('group-sessions')) return;
  measureSessionList();
}

onMounted(() => {
  void nextTick(() => {
    measureSplitBudget();
    measureSessionList();
    const sessions = sessionsListEl();
    if (typeof ResizeObserver === 'function' && sessions) {
      budgetObserver = new ResizeObserver(measureSplitBudget);
      budgetObserver.observe(sessions);
    }
    if (typeof MutationObserver === 'function' && sessions) {
      sessionsMutationObserver = new MutationObserver(measureSessionList);
      sessionsMutationObserver.observe(sessions, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    }
    sessions?.addEventListener('transitionend', onSessionsTransitionEnd);
  });
});
onBeforeUnmount(() => {
  budgetObserver?.disconnect();
  sessionsMutationObserver?.disconnect();
  sessionsListEl()?.removeEventListener('transitionend', onSessionsTransitionEnd);
});

const liveRowsHeight = ref<number | null>(null);

function applyRowsHeightLive(height: number): void {
  liveRowsHeight.value = height;
  if (gestureStartHeight !== null && height !== gestureStartHeight) {
    userAdjusted.value = true;
  }
  pinnedRowsEl.value?.style.setProperty('max-height', `${height}px`);
}

const contentHeight = ref<number | null>(null);
const firstRowHeights = ref<(number | null)[]>([]);
let gestureActive = false;

const userAdjusted = ref(safeGetString(STORAGE_KEYS.sidebarPinnedHeight) !== null);

const rowsMinHeight = computed(() => pinnedRowsMinHeight(firstRowHeights.value));
const sessionsKeep = computed(() =>
  sessionsListMinHeight(sessionsRowSpan.value, sessionsPaddingY.value, sessionRowHeight.value),
);
const layoutCap = computed(() =>
  pinnedRowsMaxHeight(viewportHeight.value, splitBudget.value, rowsMinHeight.value, sessionsKeep.value),
);

const {
  width: rowsHeight,
  dragging: resizeDragging,
  cursor: resizeCursor,
  clamp: clampRowsHeight,
  setWidth: setRowsHeight,
  onPointerDown: onResizePointerDown,
} = useResizable({
  storageKey: STORAGE_KEYS.sidebarPinnedHeight,
  defaultWidth: pinnedRowsDefaultHeight(window.innerHeight),
  min: () => rowsMinHeight.value,
  max: () => {
    if (!gestureActive) return layoutCap.value;
    return pinnedRowsResizeCeiling(layoutCap.value, contentHeight.value, rowsMinHeight.value);
  },
  axis: 'y',
  applyLive: applyRowsHeightLive,
  persist: () => userAdjusted.value,
});

watch([viewportHeight, layoutCap], () => {
  if (userAdjusted.value) return;
  rowsHeight.value = clampRowsHeight(pinnedRowsDefaultHeight(viewportHeight.value));
});

let gestureCommittedHeight: number | null = null;
let gestureStartHeight: number | null = null;
let gestureStartAdjusted = false;

function onResizeHandlePointerDown(event: PointerEvent): void {
  const el = pinnedRowsEl.value;
  if (el) {
    measureSessionList();
    gestureActive = true;
    gestureCommittedHeight = rowsHeight.value;
    gestureStartAdjusted = userAdjusted.value;
    gestureStartHeight = clampRowsHeight(el.getBoundingClientRect().height);
    rowsHeight.value = gestureStartHeight;
  }
  onResizePointerDown(event);
}

watch(resizeDragging, (dragging) => {
  if (dragging) return;
  gestureActive = false;
  const live = liveRowsHeight.value;
  if (gestureCommittedHeight !== null && isNoopGesture(gestureStartHeight, live)) {
    rowsHeight.value = clampRowsHeight(gestureCommittedHeight);
    userAdjusted.value = gestureStartAdjusted;
  }
  gestureCommittedHeight = null;
  gestureStartHeight = null;
  liveRowsHeight.value = null;
});

const handleVisible = computed(() => resizable.value || resizeDragging.value);

watch(
  [pinnedRowsEl, handleVisible, rowsHeight],
  ([el, active, height]) => {
    if (!el) return;
    if (active) el.style.setProperty('max-height', `${height}px`);
    else el.style.removeProperty('max-height');
  },
  { immediate: true },
);

function onResizeKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  measureSessionList();
  const el = pinnedRowsEl.value;
  const ceiling = pinnedRowsResizeCeiling(
    layoutCap.value,
    el?.scrollHeight ?? null,
    rowsMinHeight.value,
  );
  const base = el ? clampRowsHeight(el.getBoundingClientRect().height) : rowsHeight.value;
  const step = (event.key === 'ArrowDown' ? 1 : -1) * (event.shiftKey ? 48 : 16);
  const target = pinnedRowsKeyboardTarget(base, step, ceiling, rowsMinHeight.value);
  if (target === base) return;
  userAdjusted.value = true;
  setRowsHeight(target);
}

const separatorPosition = computed(() => {
  if (liveRowsHeight.value !== null) return liveRowsHeight.value;
  const content = contentHeight.value;
  return content === null ? rowsHeight.value : Math.min(rowsHeight.value, content);
});

const rowsScrolled = ref(false);
const rowsCanScrollDown = ref(false);

const {
  thumb: rowsThumb,
  thumbVisible: rowsThumbVisible,
  update: updateRowsThumb,
  markScrolling: markRowsScrolling,
  onThumbPointerDown: onRowsThumbPointerDown,
  onListMouseEnter: onRowsListMouseEnter,
  onListMouseLeave: onRowsListMouseLeave,
  onThumbMouseEnter: onRowsThumbMouseEnter,
  onThumbMouseLeave: onRowsThumbMouseLeave,
} = useOverlayScrollbar(pinnedRowsEl);

function updateRowsScrollState(el = pinnedRowsEl.value): void {
  if (!el) return;
  contentHeight.value = el.scrollHeight;
  const rows: HTMLElement[] = [];
  for (const child of Array.from(el.children)) {
    if (rows.length >= 2) break;
    const row = child as HTMLElement;
    if (!row.classList.contains('pin-workspace')) {
      rows.push(row);
      continue;
    }
    const header = row.querySelector<HTMLElement>(':scope > .group > .gh');
    if (header) rows.push(header);
    if (rows.length >= 2) break;
    const sessions = row.querySelector<HTMLElement>(':scope > .group > .group-sessions');
    if (!sessions || sessions.classList.contains('collapsed')) continue;
    const content = sessions.querySelectorAll<HTMLElement>(':scope > .se, :scope > .show-more-row, :scope > .group-empty');
    for (const session of Array.from(content)) {
      rows.push(session);
      if (rows.length >= 2) break;
    }
  }
  const next = [rows[0], rows[1]].map((row) => row?.getBoundingClientRect().height ?? null);
  if (
    next.length !== firstRowHeights.value.length ||
    next.some((height, index) => height !== firstRowHeights.value[index])
  ) {
    firstRowHeights.value = next;
  }
  rowsScrolled.value = el.scrollTop > 0;
  rowsCanScrollDown.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  updateRowsThumb();
}

function onRowsScroll(): void {
  updateRowsScrollState();
  markRowsScrolling();
}

let rowsObserver: ResizeObserver | null = null;

watch(pinnedRowsEl, (el, prev) => {
  if (prev) rowsObserver?.disconnect();
  rowsObserver = null;
  if (el && typeof ResizeObserver === 'function') {
    rowsObserver = new ResizeObserver(() => updateRowsScrollState());
    rowsObserver.observe(el);
  }
  if (el) {
    updateRowsScrollState(el);
  } else {
    contentHeight.value = null;
    firstRowHeights.value = [];
    rowsScrolled.value = false;
    rowsCanScrollDown.value = false;
    updateRowsThumb();
  }
});
onUpdated(() => updateRowsScrollState());
onBeforeUnmount(() => rowsObserver?.disconnect());

const { fontScale } = useAppearance();
watch(fontScale, () => {
  void nextTick(() => {
    updateRowsScrollState();
    measureSessionList();
  });
});

const draggingId = ref<string | null>(null);

const renamingSessionId = ref<string | null>(null);

const { startPinnedRowDrag, endPinnedRowDrag } = useSessionDrag();

function onDragStart(id: string, event: DragEvent): void {
  if (!event.dataTransfer) return;
  draggingId.value = id;
  startPinnedRowDrag(id, props.sessions.find((s) => s.id === id)?.workspaceId, event);
}

function onDragEnd(): void {
  draggingId.value = null;
  endPinnedRowDrag();
}

watch(
  () => props.sessions,
  (sessions) => {
    if (draggingId.value !== null && !sessions.some((s) => s.id === draggingId.value)) {
      draggingId.value = null;
    }
  },
);

const pinnedWorkspaceSet = computed(() => new Set(props.pinnedWorkspaceIds ?? []));
const resolvedEntries = computed<PinnedEntry[]>(
  () =>
    props.entries ??
    props.sessions.map((session) => ({
      key: pinnedSessionKey(session.id),
      kind: 'session' as const,
      session,
    })),
);

const {
  dropActive,
  entryDragOver,
  onEntryDragOver,
  onEntryDrop,
  onEntryDragLeave,
  onContainerDragOver,
  onContainerDrop,
  onContainerDragLeave,
} = usePinnedListDrag({
  getEntries: () => resolvedEntries.value,
  isPinnedWorkspace: (id) => pinnedWorkspaceSet.value.has(id),
  onReorder: (fromKey, toKey, position) => emit('reorderPinned', fromKey, toKey, position),
  onDropPinSession: (id, target) => emit('dropPin', id, target),
  onDropPinWorkspace: (workspaceId, target) => emit('dropPinWorkspace', workspaceId, target),
});
</script>

<template>
  <div
    ref="pinnedRootEl"
    class="pinned"
    :class="{ 'drop-active': dropActive }"
    @dragover="onContainerDragOver"
    @drop="onContainerDrop"
    @dragleave="onContainerDragLeave"
  >
    <div class="pinned-label">
      <span class="pinned-title">{{ t('sidebar.pinned') }}</span>
      <IconButton
        class="pinned-toggle"
        :class="{ 'pinned-toggle--on': collapsed }"
        size="sm"
        :label="collapsed ? t('sidebar.expandPinned') : t('sidebar.collapsePinned')"
        :tooltip="collapsed ? t('sidebar.expandPinned') : t('sidebar.collapsePinned')"
        @click.stop="toggleCollapsed"
      >
        <Icon v-if="collapsed" name="chevron-right" />
        <Icon v-else name="chevron-down" />
      </IconButton>
    </div>
    <div
      v-if="!collapsed"
      class="pinned-rows-wrap"
      :class="{ scrolled: rowsScrolled, 'more-below': rowsCanScrollDown }"
      @mouseenter="onRowsListMouseEnter"
      @mouseleave="onRowsListMouseLeave"
    >
      <div ref="pinnedRowsEl" class="pinned-rows" @scroll="onRowsScroll">
        <slot v-if="!entries" name="workspaces" />
        <template v-for="entry in resolvedEntries" :key="entry.key">
          <div
            v-if="entry.kind === 'workspace'"
            class="pin-workspace"
            :data-pin-key="entry.key"
            :data-ws-id="entry.group.workspace.id"
            :class="{
              'ws-locate-flash': flashWorkspaceId === entry.group.workspace.id,
              'drop-before': entryDragOver?.key === entry.key && entryDragOver.position === 'before',
              'drop-after': entryDragOver?.key === entry.key && entryDragOver.position === 'after',
            }"
            @dragover="onEntryDragOver(entry.key, $event)"
            @drop="onEntryDrop(entry.key, $event)"
            @dragleave="onEntryDragLeave(entry.key, $event)"
          >
            <slot name="workspace" :group="entry.group" />
          </div>
          <div
            v-else
            class="pin-row"
            :data-pin-key="entry.key"
            :class="{
              dragging: draggingId === entry.session.id,
              'drop-before': entryDragOver?.key === entry.key && entryDragOver.position === 'before',
              'drop-after': entryDragOver?.key === entry.key && entryDragOver.position === 'after',
            }"
            :draggable="renamingSessionId !== entry.session.id"
            @dragstart="onDragStart(entry.session.id, $event)"
            @dragend="onDragEnd"
            @dragover="onEntryDragOver(entry.key, $event)"
            @drop="onEntryDrop(entry.key, $event)"
            @dragleave="onEntryDragLeave(entry.key, $event)"
          >
            <SessionRow
              compact-pinned
              :session="entry.session"
              :active="entry.session.id === activeId"
              :approval-count="pendingBySession[entry.session.id]?.approvals ?? 0"
              :question-count="pendingBySession[entry.session.id]?.questions ?? 0"
              :unread="unreadBySession[entry.session.id] ?? false"
              :state-tag="props.stateTag"
              :data-session-id="entry.session.id"
              :class="{ 'se-locate-flash': flashSessionId === entry.session.id }"
              @rename-state-change="renamingSessionId = $event ? entry.session.id : null"
              @select="emit('selectSession', $event)"
              @rename="(id, title) => emit('renameSession', id, title)"
              @generate-title="(id, done) => emit('generateSessionTitle', id, done)"
              @archive="emit('archiveSession', $event)"
              @delete="emit('deleteSession', $event)"
              @fork="emit('forkSession', $event)"
              @export="emit('exportSession', $event)"
              @pin="emit('pinSession', $event)"
              @reload="emit('reloadSession', $event)"
            />
          </div>
        </template>
      </div>
      <span class="pinned-seam pinned-seam--top" aria-hidden="true"></span>
      <span class="pinned-seam pinned-seam--bottom" aria-hidden="true"></span>
      <span
        v-if="rowsThumb"
        class="pinned-thumb"
        :class="{ visible: rowsThumbVisible }"
        :style="{ top: `${rowsThumb.top}px`, height: `${rowsThumb.height}px` }"
        aria-hidden="true"
        @pointerdown="onRowsThumbPointerDown"
        @mouseenter="onRowsThumbMouseEnter"
        @mouseleave="onRowsThumbMouseLeave"
      ></span>
    </div>
    <div
      v-if="handleVisible"
      class="pinned-resize"
      :class="{ dragging: resizeDragging }"
      :style="{ cursor: resizeCursor }"
      role="separator"
      aria-orientation="horizontal"
      :aria-label="t('sidebar.resizePinnedAria')"
      :aria-valuenow="Math.round(separatorPosition)"
      :aria-valuemin="rowsMinHeight"
      :aria-valuemax="pinnedRowsResizeCeiling(layoutCap, contentHeight, rowsMinHeight)"
      tabindex="0"
      @pointerdown="onResizeHandlePointerDown"
      @keydown="onResizeKeydown"
    >
      <span class="pinned-resize-bar" aria-hidden="true"></span>
    </div>
  </div>
</template>

<style scoped>
.pinned-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 var(--sb-action-inset) var(--space-1) var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-section-label);
  text-transform: uppercase;
  color: var(--faint);
  user-select: none;
}
.pinned-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pinned-toggle {
  color: var(--faint);
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}
.pinned-label:hover .pinned-toggle,
.pinned-label:focus-within .pinned-toggle,
.pinned-toggle--on {
  opacity: 1;
}
.pinned-toggle:hover {
  color: var(--dim);
}
.pinned-toggle svg {
  width: 13px;
  height: 13px;
}

.se-locate-flash,
.pin-workspace.ws-locate-flash :deep(.gh) {
  isolation: isolate;
}
.se-locate-flash::before,
.pin-workspace.ws-locate-flash :deep(.gh)::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: var(--radius-sm);
  background: var(--color-accent-soft);
  pointer-events: none;
  animation: se-locate-fade var(--duration-flash) var(--ease-out) forwards;
}
@keyframes se-locate-fade {
  from { opacity: 1; }
  to { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .se-locate-flash::before,
  .pin-workspace.ws-locate-flash :deep(.gh)::before {
    animation: none;
  }
}

.pinned-rows {
  max-height: 40vh;
  overflow-y: auto;
  padding: 0 var(--sb-inset);
  --overlay-scrollbar-thumb-min: var(--space-6);
  scrollbar-width: none;
}
.pinned-rows::-webkit-scrollbar { display: none; }

.pinned-thumb {
  position: absolute;
  right: 0;
  width: var(--space-1);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-text) 12%, transparent);
  opacity: 0;
  pointer-events: none;
  transition:
    opacity var(--duration-base) var(--ease-out),
    background var(--duration-base) var(--ease-out);
  z-index: var(--z-raised);
  touch-action: none;
}
.pinned-thumb.visible {
  opacity: 1;
  pointer-events: auto;
}
.pinned-thumb.visible:hover {
  background: color-mix(in srgb, var(--color-text) 25%, transparent);
}
.pinned-thumb::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(-1 * var(--space-2));
  right: 0;
}

.pinned-rows-wrap {
  position: relative;
  margin: 0 calc(var(--sb-inset) * -1);
  --pinned-seam-down: linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1.5%, transparent), transparent 35%), linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1%, transparent), transparent 65%), linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 0.75%, transparent), transparent);
  --pinned-seam-up: linear-gradient(to top, color-mix(in srgb, var(--color-text) 1.5%, transparent), transparent 35%), linear-gradient(to top, color-mix(in srgb, var(--color-text) 1%, transparent), transparent 65%), linear-gradient(to top, color-mix(in srgb, var(--color-text) 0.75%, transparent), transparent);
}
.pinned-seam {
  position: absolute;
  left: 0;
  right: 0;
  height: var(--p-sidebar-seam-h);
  pointer-events: none;
  opacity: 0;
  z-index: var(--z-raised);
  transition: opacity var(--duration-slow) var(--ease-out);
}
.pinned-seam--top {
  top: 0;
  border-top: var(--p-hairline) solid var(--line);
  background: var(--pinned-seam-down);
}
.pinned-seam--bottom {
  bottom: 0;
  border-bottom: var(--p-hairline) solid var(--line);
  background: var(--pinned-seam-up);
}
.pinned-rows-wrap.scrolled .pinned-seam--top,
.pinned-rows-wrap.more-below .pinned-seam--bottom {
  opacity: 1;
}

.pinned-resize {
  height: var(--space-1);
  position: relative;
  background: transparent;
  touch-action: none;
  margin: calc(var(--space-05) * -1) calc(var(--sb-inset) * -1);
  z-index: var(--z-dropdown);
}
.pinned-resize-bar {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: var(--space-05);
  translate: 0 -50%;
  background: transparent;
  transition: background var(--duration-fast) var(--ease-out);
}
.pinned-resize:hover .pinned-resize-bar {
  background: var(--color-selected);
}
.pinned-resize.dragging .pinned-resize-bar {
  background: var(--color-line-strong);
}
.pinned-resize:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}

.pin-row.dragging { opacity: 0.45; }
.pin-row :deep(.se) {
  --se-pad-x: calc(var(--sb-pad-x, 16px) - var(--sb-inset, 8px));
}
.pin-row + .pin-row {
  padding-top: var(--space-05);
}
.pin-row + .pin-workspace,
.pin-workspace + .pin-row,
.pin-workspace + .pin-workspace {
  padding-top: var(--space-1-5);
}
.pin-row.drop-before,
.pin-workspace.drop-before {
  box-shadow: inset 0 2px 0 var(--color-accent);
}
.pin-row.drop-after,
.pin-workspace.drop-after {
  box-shadow: inset 0 -2px 0 var(--color-accent);
}
.pinned.drop-active {
  border-radius: var(--radius-sm);
  box-shadow: inset 0 0 0 1px var(--color-accent);
}
</style>
