<!-- apps/kimi-web/src/components/WorkspaceGroup.vue -->
<!-- One workspace group in the sidebar: the workspace header (folder icon,
     name / inline rename, kebab, add button), the path line, and that group's
     session rows (with show-more truncation + empty state). State, menus,
     search and the header stay in Sidebar; this component renders a single
     group and forwards every interaction back up. -->
<script setup lang="ts">
import { computed, type ComponentPublicInstance, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { WorkspaceGroup, WorkspaceView } from '../types';
import SessionRow from './SessionRow.vue';
import IconButton from './ui/IconButton.vue';
import Icon from './ui/Icon.vue';
import Tooltip from './ui/Tooltip.vue';

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
  isCollapsed: (id: string) => boolean;
  /** When true, render all loaded sessions; otherwise only the first page
   *  (`group.initialCount`). Drives the in-group show-more / show-less toggle. */
  isExpanded: (id: string) => boolean;
}>();

const emit = defineEmits<{
  groupClick: [workspaceId: string, event: MouseEvent];
  groupContextmenu: [workspace: WorkspaceView, event: MouseEvent];
  toggleWsMenu: [workspace: WorkspaceView, event: MouseEvent];
  createInWorkspace: [workspaceId: string];
  selectSession: [sessionId: string];
  renameSession: [id: string, title: string];
  archiveSession: [id: string];
  forkSession: [id: string];
  loadMore: [workspaceId: string];
  toggleExpand: [workspaceId: string];
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

// Sessions to render: all when expanded, otherwise only the first page. The
// collapse is a pure view-layer trim — data, cursor and hasMore stay intact, so
// re-expanding never refetches. When collapsed, the active session is always
// kept visible: an older session selected via Cmd/Ctrl-K search or a URL deep
// link would otherwise be hidden past the first page, so navigation would land
// on a missing row. It appends in newest-first order (older than the head).
const visibleSessions = computed(() => {
  if (props.isExpanded(props.group.workspace.id)) return props.group.sessions;
  const head = props.group.sessions.slice(0, props.group.initialCount);
  if (props.activeId && !head.some((s) => s.id === props.activeId)) {
    const active = props.group.sessions.find((s) => s.id === props.activeId);
    if (active) return [...head, active];
  }
  return head;
});
// True once more than the first page is loaded — gates the show-less/show-all toggle.
const canToggleExpand = computed(
  () => props.group.sessions.length > props.group.initialCount,
);
function showMoreCount(): number {
  return Math.max(0, props.group.workspace.sessionCount - props.group.sessions.length);
}
function showAllCount(): number {
  return props.group.sessions.length - props.group.initialCount;
}

// Hand the rename input element back to the parent's ref so Sidebar keeps
// owning focus (startRenameWorkspace focuses renameInputRef on nextTick). Only
// one group's input is mounted at a time, so sibling groups never collide.
function setRenameInputRef(el: Element | ComponentPublicInstance | null): void {
  props.renameInputRef.value = el instanceof HTMLInputElement ? el : null;
}

// Drag-to-reorder: the group header is the drag handle. We stash the workspace
// id on the dataTransfer (so drop targets elsewhere could read it) and tell the
// sidebar which group is being dragged so it can compute the new order on drop.
function onHeaderDragStart(event: DragEvent): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', props.group.workspace.id);
  emit('wsDragstart', props.group.workspace.id);
}
</script>

<template>
  <div class="group" :class="{ dragging }">
    <div
      class="gh"
      :class="{ on: group.workspace.id === activeWorkspaceId, collapsed: isCollapsed(group.workspace.id) }"
      draggable="true"
      @click.stop="emit('groupClick', group.workspace.id, $event)"
      @contextmenu="emit('groupContextmenu', group.workspace, $event)"
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
          @keydown.enter="emit('confirmRename')"
          @keydown.esc="emit('cancelRename')"
          @blur="emit('cancelRename')"
          @click.stop
        />

        <IconButton
          class="gh-more"
          :class="{ open: wsMenuOpenId === group.workspace.id }"
          size="sm"
          :label="t('sidebar.options')"
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
          @click.stop="emit('createInWorkspace', group.workspace.id)"
        >
          <Icon name="chat-new" />
        </IconButton>
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
        @select="emit('selectSession', $event)"
        @rename="(id, title) => emit('renameSession', id, title)"
        @archive="emit('archiveSession', $event)"
        @fork="emit('forkSession', $event)"
      />
      <button
        v-if="group.hasMore || group.loadingMore"
        class="show-more"
        :disabled="group.loadingMore"
        @click.stop="emit('loadMore', group.workspace.id)"
      >
        <span class="show-more-lead" aria-hidden="true"></span>
        <span class="show-more-label">{{
          group.loadingMore ? t('sidebar.loadingMore') : t('sidebar.showMore', { count: showMoreCount() })
        }}</span>
      </button>
      <button
        v-if="canToggleExpand"
        class="show-more"
        @click.stop="emit('toggleExpand', group.workspace.id)"
      >
        <span class="show-more-lead" aria-hidden="true"></span>
        <span class="show-more-label">{{
          isExpanded(group.workspace.id)
            ? t('sidebar.showLess')
            : t('sidebar.showAll', { count: showAllCount() })
        }}</span>
      </button>
      <div v-if="group.sessions.length === 0" class="group-empty">{{ t('sidebar.noSessions') }}</div>
    </div>
  </div>
</template>

<style scoped>
/* Workspace group. The --sb-* custom properties are inherited from .side in
   Sidebar.vue, so they don't need to be redeclared here. Groups stack flush —
   no bottom gap. */
.group.dragging { opacity: 0.45; }

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
  padding: var(--space-1) calc(var(--sb-pad-x) - var(--sb-inset));
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
.gh:hover { background: var(--sb-hover, var(--color-surface-sunken)); }
.gh-top {
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
  /* 26 + 2x4px .gh padding = 34px total — the sidebar-wide row height. */
  min-height: 26px;
}

.gh-folder {
  flex: none;
  color: var(--color-text-muted);
}

/* Group title — quiet by design: regular weight (no bold), muted color (one
   step lighter than the session titles), so group heads read as grouping
   labels rather than list content. */
.gh-name {
  font-size: var(--ui-font-size-lg);
  color: var(--color-text-muted);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

/* More + add buttons — hidden until hover (or while the more menu is open /
   focused). `.gh .gh-more` / `.gh .gh-add` out-specificity IconButton's display
   so the hidden default wins. */
.gh .gh-more,
.gh .gh-add {
  opacity: 0;
  pointer-events: none;
}
.gh:hover .gh-more,
.gh:hover .gh-add,
.gh:focus-within .gh-more,
.gh:focus-within .gh-add,
.gh-more.open,
.gh-more:focus-visible,
.gh-add:focus-visible {
  opacity: 1;
  pointer-events: auto;
}
.gh-more.open { color: var(--color-text); background: var(--color-line); }

.group-empty {
  padding: var(--space-1) var(--space-2) var(--space-1) calc(var(--sb-pad-x) + var(--sb-gutter) + var(--sb-gap));
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  font-family: var(--font-mono);
}
/* Show-more / show-less — a session-row-shaped compact list control (§07). The
   empty lead slot mirrors a session row's status gutter, so the label text lands
   at the exact same x as the session titles (--sb-pad-x + --sb-gutter + --sb-gap
   from the sidebar edge). Hover washes the row in the shared row hover fill,
   matching New chat / session rows; no text recolor. */
.show-more {
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
  width: 100%;
  /* Padding included (border-box) — matches the 34px sidebar-wide row height. */
  min-height: 34px;
  margin: 0;
  padding: var(--space-1) calc(var(--sb-pad-x) - var(--sb-inset));
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  text-align: left;
  cursor: pointer;
}
.show-more:hover { background: var(--sb-hover, var(--color-surface-sunken)); }
.show-more:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.show-more-lead { width: var(--sb-gutter); flex: none; }
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
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-xs);
  padding: 2px 5px;
  outline: none;
}

.gh-rename { border-radius: var(--radius-sm); font-family: var(--sans); }
.gh-add { color: var(--faint); }
.gh-add:hover { color: var(--dim); }
</style>
