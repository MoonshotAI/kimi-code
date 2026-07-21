<!-- apps/web/src/components/PinnedSessionList.vue -->
<!-- The pinned section above all workspace groups: every pinned session across
     workspaces, in the user's manual (drag) order. Rows are the shared
     SessionRow; hover shows the source workspace + cwd; drag reorders within
     the section only. State and persistence live in the client — this
     component renders the list and forwards every intent back up. -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session } from '../types';
import { moveInOrder, type DropPosition } from '../lib/workspaceOrder';
import { SESSION_ROW_DRAG_MIME } from '../lib/pinnedSessions';
import SessionRow from './SessionRow.vue';
import { Tooltip } from '@moonshot-ai/web-ui';

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

// Hover tooltip: source workspace + the session's cwd — the pinned section
// mixes workspaces, so the row alone can't say where the session lives.
function tooltipFor(s: Session): string {
  if (s.workspaceName && s.cwd) return `${s.workspaceName} · ${s.cwd}`;
  return s.workspaceName ?? s.cwd ?? '';
}

// Drag-to-reorder, scoped to this section — the workspace drag's vocabulary
// (Sidebar.vue): track the dragged row + the insertion marker (top/bottom
// half of the row under the pointer), then emit the new id order on drop.
const draggingId = ref<string | null>(null);
const dragOver = ref<{ id: string; position: DropPosition } | null>(null);

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
    </div>
    <div
      v-for="s in sessions"
      :key="s.id"
      class="pin-drop-target"
      :class="{
        dragging: draggingId === s.id,
        'drop-before': dragOver?.id === s.id && dragOver.position === 'before',
        'drop-after': dragOver?.id === s.id && dragOver.position === 'after',
      }"
      draggable="true"
      @dragstart="onDragStart(s.id, $event)"
      @dragend="onDragEnd"
      @dragover.stop="onDragOver($event, s.id)"
      @drop.stop="onDrop(s.id, $event)"
    >
      <Tooltip :text="tooltipFor(s)">
        <SessionRow
          :session="s"
          :active="s.id === activeId"
          :approval-count="pendingBySession[s.id]?.approvals ?? 0"
          :question-count="pendingBySession[s.id]?.questions ?? 0"
          :unread="unreadBySession[s.id] ?? false"
          @select="emit('selectSession', $event)"
          @rename="(id, title) => emit('renameSession', id, title)"
          @archive="emit('archiveSession', $event)"
          @fork="emit('forkSession', $event)"
          @export="emit('exportSession', $event)"
          @pin="emit('pinSession', $event)"
        />
      </Tooltip>
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

/* Drag affordance: the dragged row fades (the workspace group's .dragging),
   and a line above/below the row under the cursor marks the landing spot —
   inset shadows avoid layout shift (Sidebar's .ws-drop-target vocabulary). */
.pin-drop-target.dragging { opacity: 0.45; }
.pin-drop-target.drop-before { box-shadow: inset 0 2px 0 var(--color-accent); }
.pin-drop-target.drop-after { box-shadow: inset 0 -2px 0 var(--color-accent); }
</style>
