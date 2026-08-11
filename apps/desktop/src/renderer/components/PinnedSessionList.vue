<!-- apps/web/src/components/PinnedSessionList.vue -->
<!-- The pinned section above all workspace groups: every pinned session across
     workspaces, in the user's manual (drag) order. Rows are the shared
     SessionRow (always the flat-style variant — this section is itself a flat
     list); drag reorders within the section only. State and persistence live
     in the client — this component renders the list and forwards every intent
     back up. -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session } from '../types';
import { moveInOrder, type DropPosition } from '@moonshot-ai/app-core/lib';
import { SESSION_ROW_DRAG_MIME } from '@moonshot-ai/app-core/lib';
import { loadPinnedCollapsed, savePinnedCollapsed } from '@moonshot-ai/app-core/lib';
import SessionRow from './SessionRow.vue';
import { Icon, IconButton } from '@moonshot-ai/app-ui';

const { t } = useI18n();

const props = defineProps<{
  sessions: Session[];
  activeId: string;
  pendingBySession: Record<string, { approvals: number; questions: number }>;
  unreadBySession: Record<string, boolean>;
}>();

const emit = defineEmits<{
  selectSession: [sessionId: string];
  renameSession: [id: string, title: string];
  archiveSession: [id: string];
  forkSession: [id: string];
  exportSession: [id: string];
  pinSession: [id: string];
  pinSessionAt: [id: string, targetId: string | null, position: DropPosition];
  /** A pinned row started/ended being dragged. Sidebar broadcasts the drag to
   *  the workspace groups so only the session's home workspace accepts the
   *  drop-back (unpin). */
  sessionDragStart: [id: string, workspaceId: string];
  sessionDragEnd: [];
  reorder: [ids: string[]];
}>();

// Section collapse: the pinned block is pinned above the scrolling workspace
// list, so a long pinned set would eat the sidebar — the user can fold it
// away. Persisted (UI-only state, like the workspace fold in Sidebar).
const collapsed = ref(loadPinnedCollapsed());

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value;
  savePinnedCollapsed(collapsed.value);
}

// Feedback for a new pin: Sidebar calls this from its pin / pin-at handlers
// so the new row shows up where the user can see it. Deliberately NOT a
// sessions-length watcher: first load fetches only each workspace's first
// page and the missing pinned rows arrive in a later backfill, and that
// growth must not clear a persisted fold.
function expand(): void {
  if (!collapsed.value) return;
  collapsed.value = false;
  savePinnedCollapsed(false);
}
defineExpose({ expand });

// Drag-to-reorder, scoped to this section — the workspace drag's vocabulary
// (Sidebar.vue): track the dragged row + the insertion marker (top/bottom
// half of the row under the pointer), then emit the new id order on drop.
const draggingId = ref<string | null>(null);
const dragOver = ref<{ id: string; position: DropPosition } | null>(null);

// A row in inline-rename mode suspends dragging on its drop-target wrapper,
// so a drag gesture over the input selects text instead of moving the row.
const renamingSessionId = ref<string | null>(null);

function onDragStart(id: string, event: DragEvent): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', id);
  draggingId.value = id;
  const workspaceId = props.sessions.find((s) => s.id === id)?.workspaceId;
  if (workspaceId !== undefined) emit('sessionDragStart', id, workspaceId);
}

function onDragEnd(): void {
  draggingId.value = null;
  dragOver.value = null;
  emit('sessionDragEnd');
}

// The drop-back-to-unpin path removes the dragged row mid-drag; if dragend
// never arrives because the source element is gone, the local drag state
// would stick and the next external drag would be mistaken for an internal
// reorder — reset it once the dragged row is no longer rendered.
watch(
  () => props.sessions,
  (sessions) => {
    if (draggingId.value !== null && !sessions.some((s) => s.id === draggingId.value)) {
      draggingId.value = null;
      dragOver.value = null;
    }
  },
);

function dropPosition(event: DragEvent): DropPosition {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

// External drags (a session row pulled in from a workspace group) carry a
// marker MIME type; during dragover only the types list is readable, the id
// payload comes out on drop.
function isSessionRowDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(SESSION_ROW_DRAG_MIME) ?? false;
}

function onDragOver(event: DragEvent, targetId: string): void {
  if (draggingId.value === targetId) return;
  if (draggingId.value === null && !isSessionRowDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dragOver.value = { id: targetId, position: dropPosition(event) };
}

function onDrop(targetId: string, event: DragEvent): void {
  const fromId = draggingId.value;
  const position = dragOver.value?.id === targetId ? dragOver.value.position : 'before';
  dragOver.value = null;
  draggingId.value = null;
  if (fromId !== null) {
    if (fromId !== targetId) {
      emit('reorder', moveInOrder(props.sessions.map((s) => s.id), fromId, targetId, position));
    }
    return;
  }
  const droppedId = event.dataTransfer?.getData(SESSION_ROW_DRAG_MIME);
  if (droppedId) emit('pinSessionAt', droppedId, targetId, position);
}

// The container's own dragover/drop covers the gaps and the section label —
// the row handlers stop propagation, so landing there means "at the END".
function onContainerDragOver(event: DragEvent): void {
  if (draggingId.value === null && !isSessionRowDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const last = props.sessions[props.sessions.length - 1];
  if (last !== undefined) dragOver.value = { id: last.id, position: 'after' };
}

function onContainerDrop(event: DragEvent): void {
  const ids = props.sessions.map((s) => s.id);
  const fromId = draggingId.value;
  dragOver.value = null;
  draggingId.value = null;
  if (fromId !== null) {
    const lastId = ids[ids.length - 1];
    if (lastId !== undefined && fromId !== lastId) {
      emit('reorder', [...ids.filter((id) => id !== fromId), fromId]);
    }
    return;
  }
  const droppedId = event.dataTransfer?.getData(SESSION_ROW_DRAG_MIME);
  if (droppedId) emit('pinSessionAt', droppedId, ids[ids.length - 1] ?? null, 'after');
}

// External drags never fire dragend inside this component — clear the marker
// when the pointer leaves the section instead.
function onContainerDragLeave(event: DragEvent): void {
  if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) return;
  dragOver.value = null;
}
</script>

<template>
  <div
    class="pinned"
    @dragover="onContainerDragOver"
    @drop="onContainerDrop"
    @dragleave="onContainerDragLeave"
  >
    <div class="pinned-label">
      <span class="pinned-title">{{ t('sidebar.pinned') }}</span>
      <!-- The toggle stays visible while collapsed: a hidden control would
           leave the folded section with no discoverable way back. -->
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
    <div v-if="!collapsed" class="pinned-rows">
      <div
        v-for="s in sessions"
        :key="s.id"
        class="pin-drop-target"
        :class="{
          dragging: draggingId === s.id,
          'drop-before': dragOver?.id === s.id && dragOver.position === 'before',
          'drop-after': dragOver?.id === s.id && dragOver.position === 'after',
        }"
        :draggable="renamingSessionId !== s.id"
        @dragstart="onDragStart(s.id, $event)"
        @dragend="onDragEnd"
        @dragover.stop="onDragOver($event, s.id)"
        @drop.stop="onDrop(s.id, $event)"
      >
        <SessionRow
          :session="s"
          :active="s.id === activeId"
          :approval-count="pendingBySession[s.id]?.approvals ?? 0"
          :question-count="pendingBySession[s.id]?.questions ?? 0"
          :unread="unreadBySession[s.id] ?? false"
          @rename-state-change="renamingSessionId = $event ? s.id : null"
          @select="emit('selectSession', $event)"
          @rename="(id, title) => emit('renameSession', id, title)"
          @archive="emit('archiveSession', $event)"
          @fork="emit('forkSession', $event)"
          @export="emit('exportSession', $event)"
          @pin="emit('pinSession', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Section label — mirrors the sidebar's .side-section-label (scoped styles
   don't cross the component boundary), so the pinned caption reads exactly
   like the WORKSPACES one below it. */
.pinned-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 var(--space-3) var(--space-1) var(--space-2);
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
/* Collapse toggle — mirrors the sidebar's .side-section-toggle (scoped styles
   don't cross the component boundary): faint at rest, revealed on label
   hover/focus-within, and kept visible while the section is folded. */
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

/* Cap the expanded rows so a long pinned set can't push the workspace list
   (and the footer) out of the column — the labels stay fixed, the rows
   scroll internally. Thin overlay scrollbar mirroring the sidebar's. */
.pinned-rows {
  max-height: 40vh;
  overflow-y: auto;
}
.pinned-rows::-webkit-scrollbar { width: 4px; }
.pinned-rows::-webkit-scrollbar-track { background: transparent; }
.pinned-rows::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: var(--radius-full);
  transition: background var(--duration-base) var(--ease-out);
}
.pinned-rows:hover::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text) 12%, transparent);
}
.pinned-rows::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--color-text) 25%, transparent);
}

/* Drag affordance: the dragged row fades (the workspace group's .dragging),
   and a line above/below the row under the cursor marks the landing spot —
   inset shadows avoid layout shift (Sidebar's .ws-drop-target vocabulary). */
.pin-drop-target.dragging { opacity: 0.45; }
.pin-drop-target.drop-before { box-shadow: inset 0 2px 0 var(--color-accent); }
.pin-drop-target.drop-after { box-shadow: inset 0 -2px 0 var(--color-accent); }
</style>
