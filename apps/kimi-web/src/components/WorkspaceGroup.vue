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
  /** When true, render the workspace root path as a stable subtitle line. */
  showPath: boolean;
  isCollapsed: (id: string) => boolean;
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
      :class="{ on: group.workspace.id === activeWorkspaceId, collapsed: isCollapsed(group.workspace.id), 'show-path': showPath }"
      draggable="true"
      @click.stop="emit('groupClick', group.workspace.id, $event)"
      @contextmenu="emit('groupContextmenu', group.workspace, $event)"
      @dragstart="onHeaderDragStart"
      @dragend="emit('wsDragend')"
    >
      <div class="gh-top">
        <!-- Folder icon -->
        <Icon v-if="isCollapsed(group.workspace.id)" class="gh-folder" name="folder-closed" size="sm" />
        <Icon v-else class="gh-folder" name="folder" size="sm" />

        <!-- Workspace name -->
        <span
          v-if="renamingId !== group.workspace.id"
          class="gh-name"
        >{{ group.workspace.name }}</span>
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

        <Tooltip :text="t('sidebar.options')">
          <IconButton
            class="gh-more"
            :class="{ open: wsMenuOpenId === group.workspace.id }"
            size="sm"
            :label="t('sidebar.options')"
            aria-haspopup="menu"
            :aria-expanded="wsMenuOpenId === group.workspace.id"
            @click.stop="emit('toggleWsMenu', group.workspace, $event)"
          >
            <Icon name="dots-horizontal" size="sm" />
          </IconButton>
        </Tooltip>

        <Tooltip :text="t('workspace.newInGroup')">
          <IconButton
            class="gh-add"
            size="sm"
            :label="t('workspace.newInGroup')"
            @click.stop="emit('createInWorkspace', group.workspace.id)"
          >
            <Icon name="plus" />
          </IconButton>
        </Tooltip>
      </div>

      <Tooltip :text="group.workspace.root">
        <div class="gh-path">{{ group.workspace.shortPath || group.workspace.root }}</div>
      </Tooltip>
    </div>
    <div
      class="group-sessions"
      :class="{ collapsed: isCollapsed(group.workspace.id) }"
      :inert="isCollapsed(group.workspace.id)"
    >
      <SessionRow
        v-for="s in group.sessions"
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
        {{
          group.loadingMore
            ? t('sidebar.loadingMore')
            : t('sidebar.showMore', { count: Math.max(0, group.workspace.sessionCount - group.sessions.length) })
        }}
      </button>
      <div v-if="group.sessions.length === 0" class="group-empty">{{ t('sidebar.noSessions') }}</div>
    </div>
  </div>
</template>

<style scoped>
/* Workspace group. The --sb-* custom properties are inherited from .side in
   Sidebar.vue, so they don't need to be redeclared here. */
.group { padding-bottom: var(--space-2); }
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
   (6px margin + 10px padding), so the folder icon lands at --sb-pad-x and the
   name lines up with the session titles below. Hover washes the whole header
   (name row + path) in the sunken surface. */
.gh {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: var(--space-1) var(--space-2);
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
.gh:hover { background: var(--color-surface-sunken); }
.gh-top {
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
}

.gh-folder {
  flex: none;
  color: var(--color-text-muted);
  /* 14px icon + margin fills the --sb-gutter icon slot */
  margin-right: calc(var(--sb-gutter) - 14px);
}

.gh-name {
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.gh-path {
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: calc(var(--sb-gutter) + var(--sb-gap));
  font-size: var(--text-xs);
  max-height: 0;
  opacity: 0;
  transition: max-height var(--duration-base) var(--ease-out),
    opacity var(--duration-base) var(--ease-out);
}
/* Path subtitle — revealed only when the section-header "show paths" toggle is
   on (`.show-path`) or the group is collapsed. Driven by explicit toggle state
   rather than hover/focus, so the header height never shifts under the pointer
   (a11y: stable layout) and the path stays reachable for touch/keyboard users. */
.gh.show-path .gh-path,
.gh.collapsed .gh-path {
  max-height: 1.4em;
  opacity: 1;
}

/* More button — hidden until hover (or while its menu is open / focused).
   `.gh .gh-more` out-specificities IconButton's display so the hidden default wins. */
.gh .gh-more { display: none; }
.gh:hover .gh-more,
.gh-more.open,
.gh-more:focus-visible { display: inline-flex; }
.gh-more.open { color: var(--color-text); background: var(--color-line); }

.group-empty {
  padding: var(--space-1) var(--space-2) var(--space-1) calc(var(--sb-pad-x) + var(--sb-gutter) + var(--sb-gap));
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  font-family: var(--font-mono);
}
.show-more {
  display: block;
  width: 100%;
  padding: var(--space-1) var(--space-2) var(--space-1) calc(var(--sb-pad-x) + var(--sb-gutter) + var(--sb-gap));
  background: none;
  border: none;
  color: var(--color-text);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  cursor: pointer;
  text-align: left;
}
.show-more:hover {
  color: var(--color-accent-hover);
  background: var(--color-surface-sunken);
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
