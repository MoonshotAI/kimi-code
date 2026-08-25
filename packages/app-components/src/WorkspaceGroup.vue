<!-- One workspace group in the sidebar: the workspace header (folder icon,
     name / inline rename, kebab, add button), the path line, and that group's
     session rows (with expand/collapse truncation + empty state). State, menus,
     search and the header stay in Sidebar; this component renders a single
     group and forwards every interaction back up. -->
<script setup lang="ts">
import { computed, ref, type ComponentPublicInstance, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { WorkspaceGroup, WorkspaceView } from '@moonshot-ai/app-core/client/types';
import SessionRow from './SessionRow.vue';
import { SESSION_ROW_DRAG_MIME } from '@moonshot-ai/app-core/lib';
import { Icon, IconButton, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';

const { t } = useI18n();

const props = defineProps<{
  group: WorkspaceGroup;
  activeWorkspaceId: string | null;
  activeId: string;
  renamingId: string | null;
  renameValue: string;
  renameInputRef: Ref<HTMLInputElement | null>;
  pendingBySession: Record<string, { approvals: number; questions: number }>;
  unreadBySession: Record<string, boolean>;
  wsMenuOpenId: string | null;
  /** True while this group is the active drag source (drag-to-reorder). */
  dragging: boolean;
  /** False while the sidebar sorts groups by recency: the order is computed,
   *  so the header drag handle is suspended (a drop could not stick). */
  sortable?: boolean;
  isCollapsed: (id: string) => boolean;
  /** Rows-per-group display cap (undefined = the first page,
   *  `group.initialCount`). Drives the in-group expand / collapse controls. */
  visibleLimit: (id: string) => number | undefined;
  /** Session being locate-flashed by the search dialog (null when idle) — the
   *  matching row pulses an accent wash so the eye lands on it. */
  flashSessionId?: string | null;
  /** The pinned session currently being dragged back (null when idle). Only
   *  its home workspace is a drop target; see the drag handlers below. */
  pinnedDragSession?: { id: string; workspaceId: string } | null;
  /** State tag forwarded to each SessionRow ('open' in the status tabs'
   *  grouped open list; unset = no tag). */
  stateTag?: 'open' | 'done';
}>();

const emit = defineEmits<{
  groupClick: [workspaceId: string, event: MouseEvent];
  groupContextmenu: [workspace: WorkspaceView, event: MouseEvent];
  toggleWsMenu: [workspace: WorkspaceView, event: MouseEvent];
  createInWorkspace: [workspaceId: string];
  selectSession: [sessionId: string];
  renameSession: [id: string, title: string];
  /** Gen Title (✨ in the rename input): force-regenerate via the daemon. */
  generateSessionTitle: [id: string, done: (title: string | null) => void];
  archiveSession: [id: string];
  forkSession: [id: string];
  exportSession: [id: string];
  pinSession: [id: string];
  dropPinnedSession: [id: string];
  expand: [workspaceId: string];
  collapse: [workspaceId: string];
  confirmRename: [];
  cancelRename: [];
  updateRenameValue: [value: string];
  wsDragstart: [workspaceId: string];
  wsDragend: [];
}>();

// v-model bridge: Sidebar owns renameValue (confirmRenameWorkspace reads it),
// so the input mirrors the prop and pushes every edit back up — identical to
// the previous `v-model="renameValue"` against a local ref.
const renameValueModel = computed<string>({
  get: () => props.renameValue,
  set: (value: string) => emit('updateRenameValue', value),
});

// Drag-back-to-unpin: while a pinned session is being dragged (tracked by the
// Sidebar and passed down as `pinnedDragSession`), only its home workspace is
// a drop target — dropping there unpins. Every other group refuses the drop:
// its dragover is never prevented, so the browser shows the no-drop cursor on
// top of the blocked styling below.
const pinnedDropHover = ref(false);

const isPinnedDragActive = computed(() => props.pinnedDragSession != null);
const isPinnedDropTarget = computed(
  () => props.pinnedDragSession?.workspaceId === props.group.workspace.id,
);

function onPinnedDragOver(event: DragEvent): void {
  if (props.pinnedDragSession == null) return;
  if (!isPinnedDropTarget.value) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  pinnedDropHover.value = true;
}

function onPinnedDrop(event: DragEvent): void {
  if (props.pinnedDragSession == null || !isPinnedDropTarget.value) return;
  event.preventDefault();
  pinnedDropHover.value = false;
  emit('dropPinnedSession', props.pinnedDragSession.id);
}

function onPinnedDragLeave(event: DragEvent): void {
  if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) return;
  pinnedDropHover.value = false;
}

// Sessions to render: the loaded rows up to the group's display limit (the
// first page until expanded). The cap is a pure view-layer trim — data, cursor
// and hasMore stay intact, so re-expanding after a collapse never refetches.
// When the active session sits past the cap (selected via Cmd/Ctrl-K search or
// a URL deep link), it is appended to keep the selection visible; it lands in
// newest-first order (older than the head).
const displayLimit = computed(
  () => props.visibleLimit(props.group.workspace.id) ?? props.group.initialCount,
);
const visibleSessions = computed(() => {
  const head = props.group.sessions.slice(0, displayLimit.value);
  if (props.activeId && !head.some((s) => s.id === props.activeId)) {
    const active = props.group.sessions.find((s) => s.id === props.activeId);
    if (active) return [...head, active];
  }
  return head;
});
// More rows can be revealed while undisplayed loaded rows remain or the server
// has another page (loadingMore keeps the button up in its busy state).
const canExpand = computed(
  () =>
    props.group.sessions.length > displayLimit.value ||
    props.group.hasMore ||
    props.group.loadingMore,
);
const canCollapse = computed(() => displayLimit.value > props.group.initialCount);

// Hand the rename input element back to the parent's ref so Sidebar keeps
// owning focus (startRenameWorkspace focuses renameInputRef on nextTick). Only
// one group's input is mounted at a time, so sibling groups never collide.
function setRenameInputRef(el: Element | ComponentPublicInstance | null): void {
  props.renameInputRef.value = el instanceof HTMLInputElement ? el : null;
}

// IME guard: Enter that only confirms a composition candidate must not commit.
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();
function onRenameEnter(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;
  emit('confirmRename');
}
function onRenameEscape(e: KeyboardEvent): void {
  // An Escape that only dismisses the IME candidate panel must not cancel the rename.
  if (isComposingKeyEvent(e)) return;
  emit('cancelRename');
}

// A session row reports its rename-mode transitions so the draggable row /
// header containers can suspend dragging while a text edit is in flight —
// otherwise the drag gesture over the input moves the row instead of
// selecting text (same treatment as the workspace header below).
const renamingSessionId = ref<string | null>(null);

// Right-click over the open rename input belongs to the native text-editing
// menu (same exception as SessionRow): don't open the workspace menu there.
function onHeaderContextMenu(e: MouseEvent): void {
  if (props.renamingId === props.group.workspace.id) return;
  emit('groupContextmenu', props.group.workspace, e);
}

// Drag-to-reorder: the group header is the drag handle. We stash the workspace
// id on the dataTransfer (so drop targets elsewhere could read it) and tell the
// sidebar which group is being dragged so it can compute the new order on drop.
// Suspended while the sidebar is in recency sort (sortable === false) — the
// order is computed there, a drop could not stick.
function onHeaderDragStart(event: DragEvent): void {
  if (props.sortable === false) return;
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', props.group.workspace.id);
  emit('wsDragstart', props.group.workspace.id);
}

// Session rows double as drag sources for the pinned section: dropping a row
// there pins the session at the drop spot (PinnedSessionList reads the id back
// from the dataTransfer). The custom MIME type marks this as a session-row
// drag — workspace-header and OS file drags never set it.
function onSessionDragStart(id: string, event: DragEvent): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(SESSION_ROW_DRAG_MIME, id);
  event.dataTransfer.setData('text/plain', id);
}
</script>

<template>
  <div
    class="group"
    :class="{
      dragging,
      'pinned-drag-active': isPinnedDragActive && isPinnedDropTarget,
      'pinned-drop-hover': pinnedDropHover,
      'pinned-drop-blocked': isPinnedDragActive && !isPinnedDropTarget,
    }"
    @dragover="onPinnedDragOver"
    @drop="onPinnedDrop"
    @dragleave="onPinnedDragLeave"
  >
    <div
      class="gh"
      :class="{ on: group.workspace.id === activeWorkspaceId && activeId === '', collapsed: isCollapsed(group.workspace.id) }"
      :draggable="sortable !== false && renamingId !== group.workspace.id"
      @click.stop="emit('groupClick', group.workspace.id, $event)"
      @contextmenu="onHeaderContextMenu"
      @dragstart="onHeaderDragStart"
      @dragend="emit('wsDragend')"
    >
      <div class="gh-top">
        <!-- Folder icon -->
        <Icon v-if="isCollapsed(group.workspace.id)" class="gh-folder" name="folder-closed" />
        <Icon v-else class="gh-folder" name="folder" />

        <!-- Workspace name — hover reveals the full root path -->
        <Tooltip v-if="renamingId !== group.workspace.id" :text="group.workspace.root">
          <span class="gh-name">{{ group.workspace.name }}</span>
        </Tooltip>
        <input
          v-else
          :ref="setRenameInputRef"
          v-model="renameValueModel"
          class="gh-rename"
          type="text"
          @keydown.enter="onRenameEnter"
          @keydown.esc="onRenameEscape"
          @compositionstart="handleCompositionStart"
          @compositionend="handleCompositionEnd"
          @blur="emit('cancelRename')"
          @click.stop
        />

        <!-- Hover actions — float over the row's right edge (no reserved
             layout space, the name gets the full row width when idle). Hidden
             while renaming so the floating buttons can't cover the input. -->
        <div
          v-if="renamingId !== group.workspace.id"
          class="gh-actions"
          :class="{ open: wsMenuOpenId === group.workspace.id }"
        >
          <IconButton
            class="gh-more"
            :class="{ open: wsMenuOpenId === group.workspace.id }"
            size="sm"
            :label="t('sidebar.options')"
            :tooltip="t('sidebar.options')"
            aria-haspopup="menu"
            :aria-expanded="wsMenuOpenId === group.workspace.id"
            @click.stop="emit('toggleWsMenu', group.workspace, $event)"
          >
            <Icon name="dots-horizontal" />
          </IconButton>

          <IconButton
            class="gh-add"
            size="sm"
            :label="t('workspace.newInGroup')"
            :tooltip="t('workspace.newInGroup')"
            @click.stop="emit('createInWorkspace', group.workspace.id)"
          >
            <Icon name="chat-new" />
          </IconButton>
        </div>
      </div>
    </div>
    <div
      class="group-sessions"
      :class="{ collapsed: isCollapsed(group.workspace.id) }"
      :inert="isCollapsed(group.workspace.id)"
    >
      <SessionRow
        v-for="s in visibleSessions"
        :key="s.id"
        :session="s"
        :active="s.id === activeId"
        :approval-count="pendingBySession[s.id]?.approvals ?? 0"
        :question-count="pendingBySession[s.id]?.questions ?? 0"
        :unread="unreadBySession[s.id] ?? false"
        :state-tag="props.stateTag"
        :draggable="renamingSessionId !== s.id"
        :data-session-id="s.id"
        :class="{ 'se-locate-flash': flashSessionId === s.id }"
        @dragstart="onSessionDragStart(s.id, $event)"
        @rename-state-change="renamingSessionId = $event ? s.id : null"
        @select="emit('selectSession', $event)"
        @rename="(id, title) => emit('renameSession', id, title)"
        @generate-title="(id, done) => emit('generateSessionTitle', id, done)"
        @archive="emit('archiveSession', $event)"
        @fork="emit('forkSession', $event)"
        @export="emit('exportSession', $event)"
        @pin="emit('pinSession', $event)"
      />
      <div v-if="canExpand || canCollapse" class="show-more-row">
        <button
          v-if="canExpand"
          class="show-more"
          :disabled="group.loadingMore"
          @click.stop="emit('expand', group.workspace.id)"
        >
          <Icon name="chevron-down" size="sm" />
          <span class="show-more-label">{{
            group.loadingMore ? t('sidebar.loadingMore') : t('sidebar.showMore')
          }}</span>
        </button>
        <span v-if="canExpand && canCollapse" class="show-more-sep" aria-hidden="true">·</span>
        <button
          v-if="canCollapse"
          class="show-more"
          @click.stop="emit('collapse', group.workspace.id)"
        >
          <Icon name="chevron-up" size="sm" />
          <span class="show-more-label">{{ t('sidebar.showLess') }}</span>
        </button>
      </div>
      <div v-if="group.sessions.length === 0" class="group-empty">{{
        group.pinnedCount > 0
          ? t('sidebar.allPinned', { count: group.pinnedCount })
          : t('sidebar.noSessions')
      }}</div>
    </div>
  </div>
</template>

<style scoped>
/* Workspace group. The --sb-* custom properties are inherited from .side in
   Sidebar.vue, so they don't need to be redeclared here. Groups stack flush —
   no bottom gap. */
.group.dragging { opacity: 0.45; }

/* Drag-back-to-unpin affordance: while a pinned session is dragged, its home
   workspace is the only drop target (accent frame, stronger on hover); every
   other group shows the no-drop cursor — the browser's own 🚫 also applies
   there, since their dragover is never prevented. */
.group.pinned-drag-active,
.group.pinned-drop-hover {
  border-radius: var(--radius-sm);
}
.group.pinned-drag-active { box-shadow: inset 0 0 0 1px var(--color-accent); }
.group.pinned-drop-hover { box-shadow: inset 0 0 0 2px var(--color-accent); }
.group.pinned-drop-blocked,
.group.pinned-drop-blocked :deep(*) {
  cursor: no-drop;
}

/* Session-row locate flash (search dialog): the picked row washes a soft
   accent overlay that fades out — an overlay (not a background animation) so
   the selected fill underneath (.se.on) never gets overridden and nothing
   snaps back when the wash ends (same treatment as the workspace-header
   flash in Sidebar and the settings provider row's pp-flash). The class
   lands on SessionRow's root (class fallthrough), which carries this
   component's scope id, so the plain selectors match. */
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

/* Session list: collapses/expands via a height transition. `interpolate-size:
   allow-keywords` (set on :root) lets `height: auto` interpolate instead of
   snap. `inert` (set in the template when collapsed) keeps the hidden rows out
   of the tab order / a11y tree, matching the old `v-show` behavior. */
.group-sessions {
  height: auto;
  overflow: hidden;
  transition: height var(--duration-base) var(--ease-out);
}
.group-sessions.collapsed {
  height: 0;
}

/* Workspace header — an inset rounded row that mirrors the session-row inset
   (container --sb-inset + row padding), so the folder icon lands at --sb-pad-x
   and the name lines up with the session titles below. Hover washes the whole
   header in the row hover fill. */
.gh {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 8px calc(var(--sb-pad-x) - var(--sb-inset));
  border-radius: var(--radius-sm);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text);
  user-select: none;
  position: relative;
  /* The header doubles as the drag handle for reordering. */
  cursor: grab;
}
.gh:active { cursor: grabbing; }
.gh:hover { background: var(--sb-hover, var(--color-hover)); }
/* Active workspace with no session selected (the draft state — e.g. right
   after adding the workspace, or after "New chat"): the same neutral selected
   fill as a session row — selection reads as "where I am". Listed after
   :hover so the fill wins on hover, mirroring .se.on in SessionRow. */
.gh.on { background: var(--sb-selected, var(--color-selected)); }
.gh-top {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
  /* Header height is font-driven: name line-height (13×1.25≈16px) + 2×5px
     .gh padding ≈ 26px. The floating .gh-actions never contribute to height. */
}

.gh-folder {
  flex: none;
  color: var(--color-text-muted);
}

/* Group title — quiet by design: medium weight, muted color (one
   step lighter than the session titles), so group heads read as grouping
   labels rather than list content. */
.gh-name {
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  color: var(--color-text-muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

/* More + add buttons — float over the row's right edge instead of reserving
   layout space, so the name can use the full row width when idle (no
   truncation caused by invisible buttons). Revealed on hover / keyboard focus
   / while the more menu is open; the layer paints nothing — the name dissolves
   (mask fade on .gh-name) before it can reach the buttons. */
.gh-actions {
  position: absolute;
  /* Right edge lands --sb-action-inset inside the row's border edge — the same
     anchor the session-row hover cluster uses (.act .ha in SessionRow), so
     hovering a group header vs a session row puts the trailing icons at the
     same x. .gh-top is the containing block, whose right edge is one .gh
     padding (--sb-pad-x − --sb-inset) in from the border edge; cancel that,
     keep the inset. */
  right: calc(var(--sb-action-inset) - (var(--sb-pad-x) - var(--sb-inset)));
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding-left: var(--space-1);
  border-radius: var(--radius-sm);
  isolation: isolate;
  opacity: 0;
  pointer-events: none;
}
/* Group title vs. floating actions: no plate, no wash — the name dissolves
   before it reaches the buttons: a mask-image fade into a fully transparent
   plateau. At rest a subtle 16px dissolve stands in for the ellipsis
   (text-overflow: clip so a long tail dissolves instead of dotting). On hover
   the mask becomes opaque → 26px dissolve → solid-transparent plateau: the
   plateau (64px) covers the whole floating cluster (≈60px wide), so not even
   a half-faded glyph can sit under a button. The fade is zone-based, so short
   names render untouched. */
.gh-name {
  /* Rest: no plateau (nothing overlaps the name until hover) — the tail
     dissolves over the last 16px, reaching transparent exactly at the box
     edge, so long names keep ~16px more visible text. */
  --sb-fade: 0px;
  --sb-fade-len: 16px;
  text-overflow: clip;
  -webkit-mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - var(--sb-fade) - var(--sb-fade-len)), transparent calc(100% - var(--sb-fade)));
  mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - var(--sb-fade) - var(--sb-fade-len)), transparent calc(100% - var(--sb-fade)));
}
.gh:hover .gh-name,
.gh:focus-within .gh-name,
.gh:has(.gh-actions.open) .gh-name {
  --sb-fade: 64px;
  --sb-fade-len: 26px;
}
.gh-actions > * {
  position: relative;
  z-index: 1;
}
.gh:hover .gh-actions,
.gh:focus-within .gh-actions,
.gh-actions.open {
  opacity: 1;
  pointer-events: auto;
}
.gh-more.open { color: var(--color-text); background: var(--color-line); }

.group-empty {
  /* Left padding lands the text at the same x as session titles / the
     show-more label: (pad-x − inset) row padding + gutter + gap. */
  padding: var(--space-1) var(--space-2) var(--space-1) calc(var(--sb-pad-x) - var(--sb-inset) + var(--sb-gutter) + var(--sb-gap));
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  /* A status label, not content — like the section captions, it must not be
     text-selectable. */
  user-select: none;
}
/* Show-more / show-less — compact list controls sharing one row (§07): expand
   (chevron-down) on the left, collapse (chevron-up) right after it, with a
   faint middot between them when both are present. The row's own indent lands
   the first button's chevron exactly at the session-title x (--sb-gutter +
   --sb-gap past the row padding), so buttons stay content-width and hover
   washes just the button as a snug pill — never the full row. */
.show-more-row {
  display: flex;
  align-items: center;
  padding-left: calc(var(--sb-gutter) + var(--sb-gap));
}
.show-more {
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
  margin: 0;
  padding: 8px calc(var(--sb-pad-x) - var(--sb-inset));
  /* Let the pill shrink at the narrowest sidebar widths so the label
     truncates instead of the row overflowing the group. */
  min-width: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  text-align: left;
  cursor: pointer;
}
.show-more:hover { background: var(--sb-hover, var(--color-hover)); }
.show-more:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.show-more-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.show-more-sep {
  margin: 0 var(--space-1);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  user-select: none;
}
.show-more-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Inline workspace rename input */
.gh-rename {
  flex: 1;
  min-width: 0;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-regular);
  color: var(--color-text);
  background: var(--color-bg);
  border: 0.5px solid var(--color-accent);
  border-radius: var(--radius-xs);
  padding: 2px 5px;
  outline: none;
}

.gh-rename { border-radius: var(--radius-sm); font-family: var(--sans); }
.gh-add { color: var(--faint); }
.gh-add:hover { color: var(--dim); }
</style>
