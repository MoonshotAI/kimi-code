<!-- apps/web/src/components/PinnedSessionList.vue -->
<!-- The pinned section above all workspace groups: every pinned session across
     workspaces, in pure recency order (updatedAt desc — no manual ordering,
     no attention tiering; the facade owns the order). Rows are the shared
     SessionRow (always the flat-style variant — this section is itself a flat
     list). Drag vocabulary: drag a session row IN to pin it (drop anywhere in
     the section — position carries no ordering meaning), drag a pinned row
     OUT to its home workspace group / the flat list to unpin (that half lives
     in Sidebar/WorkspaceGroup). State and persistence live in the client —
     this component renders the list and forwards every intent back up. -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session } from '../types';
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
  /** Status view passes 'open' so pinned rows carry the same state tag as the
   *  open tab; the flat/grouped views leave it unset (no tag). */
  stateTag?: 'open' | 'done';
  /** Session being locate-flashed by the search dialog (null when idle) — the
   *  matching row pulses an accent wash so the eye lands on it. */
  flashSessionId?: string | null;
}>();

const emit = defineEmits<{
  selectSession: [sessionId: string];
  renameSession: [id: string, title: string];
  /** Gen Title (✨ in the rename input): force-regenerate via the daemon. */
  generateSessionTitle: [id: string, done: (title: string | null) => void];
  archiveSession: [id: string];
  forkSession: [id: string];
  exportSession: [id: string];
  pinSession: [id: string];
  /** A session row was dropped into the section (pin it). */
  dropPin: [id: string];
  /** A pinned row started/ended being dragged. Sidebar broadcasts the drag to
   *  the workspace groups so only the session's home workspace accepts the
   *  drop-back (unpin). */
  sessionDragStart: [id: string, workspaceId: string];
  sessionDragEnd: [];
}>();

// Section collapse: the pinned block is pinned above the scrolling workspace
// list, so a long pinned set would eat the sidebar — the user can fold it
// away. Persisted (UI-only state, like the workspace fold in Sidebar).
const collapsed = ref(loadPinnedCollapsed());

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value;
  savePinnedCollapsed(collapsed.value);
}

// Feedback for a new pin: Sidebar calls this from its pin / drop-pin handlers
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

// Row dragging exists for the drag-OUT (unpin) gesture — there is no
// in-section reorder (the section renders in recency order). We only track
// the dragged row for the fade + the drag broadcast to workspace groups.
const draggingId = ref<string | null>(null);

// A row in inline-rename mode suspends dragging on its wrapper, so a drag
// gesture over the input selects text instead of moving the row.
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
  emit('sessionDragEnd');
}

// The drop-back-to-unpin path removes the dragged row mid-drag; if dragend
// never arrives because the source element is gone, the local drag state
// would stick — reset it once the dragged row is no longer rendered.
watch(
  () => props.sessions,
  (sessions) => {
    if (draggingId.value !== null && !sessions.some((s) => s.id === draggingId.value)) {
      draggingId.value = null;
    }
  },
);

// Drop-in (pin): external session-row drags carry a marker MIME type; during
// dragover only the types list is readable, the id payload comes out on drop.
// Internal drags (a pinned row on its way out) set no marker, so the section
// never accepts its own rows back.
const dropActive = ref(false);

function isSessionRowDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(SESSION_ROW_DRAG_MIME) ?? false;
}

function onContainerDragOver(event: DragEvent): void {
  if (!isSessionRowDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropActive.value = true;
}

function onContainerDrop(event: DragEvent): void {
  dropActive.value = false;
  const droppedId = event.dataTransfer?.getData(SESSION_ROW_DRAG_MIME);
  if (droppedId) emit('dropPin', droppedId);
}

// External drags never fire dragend inside this component — clear the marker
// when the pointer leaves the section instead.
function onContainerDragLeave(event: DragEvent): void {
  if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) return;
  dropActive.value = false;
}
</script>

<template>
  <div
    class="pinned"
    :class="{ 'drop-active': dropActive }"
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
        class="pin-row"
        :class="{ dragging: draggingId === s.id }"
        :draggable="renamingSessionId !== s.id"
        @dragstart="onDragStart(s.id, $event)"
        @dragend="onDragEnd"
      >
        <SessionRow
          :session="s"
          :active="s.id === activeId"
          :approval-count="pendingBySession[s.id]?.approvals ?? 0"
          :question-count="pendingBySession[s.id]?.questions ?? 0"
          :unread="unreadBySession[s.id] ?? false"
          :state-tag="props.stateTag"
          :data-session-id="s.id"
          :class="{ 'se-locate-flash': flashSessionId === s.id }"
          @rename-state-change="renamingSessionId = $event ? s.id : null"
          @select="emit('selectSession', $event)"
          @rename="(id, title) => emit('renameSession', id, title)"
          @generate-title="(id, done) => emit('generateSessionTitle', id, done)"
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

/* Session-row locate flash (search dialog): identical treatment to the
   grouped rows' flash in WorkspaceGroup — a soft accent overlay fading out
   above the row's resting fill, so nothing snaps when it ends. The class
   lands on SessionRow's root (class fallthrough), which carries this
   component's scope id. */
.se-locate-flash { isolation: isolate; }
.se-locate-flash::before {
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
  .se-locate-flash::before { animation: none; }
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
   and an accent frame marks the section while an external session-row drag
   is over it (Sidebar's .pinned-drag-active vocabulary, no layout shift). */
.pin-row.dragging { opacity: 0.45; }
.pinned.drop-active {
  border-radius: var(--radius-sm);
  box-shadow: inset 0 0 0 1px var(--color-accent);
}
</style>
