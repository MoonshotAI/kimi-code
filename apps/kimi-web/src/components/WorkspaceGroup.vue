<!-- apps/kimi-web/src/components/WorkspaceGroup.vue -->
<!-- One workspace group in the sidebar: the workspace header (folder icon,
     name / inline rename, kebab, add button), the path line, and that group's
     session rows (with show-more truncation + empty state). State, menus,
     search and the header stay in Sidebar; this component renders a single
     group and forwards every interaction back up. -->
<script setup lang="ts">
import { computed, type ComponentPublicInstance, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session, WorkspaceGroup, WorkspaceView } from '../types';
import SessionRow from './SessionRow.vue';

const { t } = useI18n();

const props = defineProps<{
  group: WorkspaceGroup;
  activeWorkspaceId: string | null;
  activeId: string;
  selectedIds: Set<string>;
  renamingId: string | null;
  renameValue: string;
  renameInputRef: Ref<HTMLInputElement | null>;
  pendingBySession: Record<string, { approvals: number; questions: number }>;
  unreadBySession: Record<string, boolean>;
  wsMenuOpenId: string | null;
  /** True while this group is the active drag source (drag-to-reorder). */
  dragging: boolean;
  isCollapsed: (id: string) => boolean;
  isExpanded: (id: string) => boolean;
  visibleSessions: (sessions: Session[], expanded: boolean, activeId?: string) => Session[];
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
      :class="{ on: group.workspace.id === activeWorkspaceId, sel: selectedIds.has(group.workspace.id) }"
      draggable="true"
      @click.stop="emit('groupClick', group.workspace.id, $event)"
      @contextmenu="emit('groupContextmenu', group.workspace, $event)"
      @dragstart="onHeaderDragStart"
      @dragend="emit('wsDragend')"
    >
      <div class="gh-top">
        <!-- Folder icon -->
        <svg
          class="gh-folder"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
          aria-hidden="true"
        >
          <template v-if="isCollapsed(group.workspace.id)">
            <rect x="1" y="3.5" width="12" height="8.5" rx="1"/>
            <path d="M1 5V3.5A1 1 0 0 1 2 2.5h3.5l1.3 2"/>
          </template>
          <template v-else>
            <path d="M1 3.5V2.5A1 1 0 0 1 2 1.5h3.5l1.3 2h5.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"/>
            <path d="M1 5.5h12"/>
          </template>
        </svg>

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

        <button
          type="button"
          class="gh-more"
          :class="{ open: wsMenuOpenId === group.workspace.id }"
          :title="t('sidebar.options')"
          :aria-label="t('sidebar.options')"
          aria-haspopup="menu"
          :aria-expanded="wsMenuOpenId === group.workspace.id"
          @click.stop="emit('toggleWsMenu', group.workspace, $event)"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            <circle cx="8" cy="3" r="1.3" />
            <circle cx="8" cy="8" r="1.3" />
            <circle cx="8" cy="13" r="1.3" />
          </svg>
        </button>

        <button
          type="button"
          class="gh-add"
          :title="t('workspace.newInGroup')"
          :aria-label="t('workspace.newInGroup')"
          @click.stop="emit('createInWorkspace', group.workspace.id)"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 3v10M3 8h10"/>
          </svg>
        </button>
      </div>

      <div class="gh-path" :title="group.workspace.root">{{ group.workspace.shortPath || group.workspace.root }}</div>
    </div>
    <div v-show="!isCollapsed(group.workspace.id)" class="group-sessions">
      <SessionRow
        v-for="s in visibleSessions(group.sessions, isExpanded(group.workspace.id), activeId)"
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
        v-if="!isExpanded(group.workspace.id) && visibleSessions(group.sessions, false, activeId).length < group.sessions.length"
        class="show-more"
        @click.stop="emit('toggleExpand', group.workspace.id)"
      >
        {{ t('sidebar.showMore', { count: group.sessions.length - visibleSessions(group.sessions, false, activeId).length }) }}
      </button>
      <div v-if="group.sessions.length === 0" class="group-empty">{{ t('sidebar.noSessions') }}</div>
    </div>
  </div>
</template>

<style scoped>
/* Workspace group. The --sb-* custom properties are inherited from .side in
   Sidebar.vue, so they don't need to be redeclared here. */
.group { padding-bottom: 6px; }
.group.dragging { opacity: 0.45; }
.gh {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 var(--sb-pad-x) 4px;
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  user-select: none;
  position: relative;
  /* The header doubles as the drag handle for reordering. */
  cursor: grab;
}
.gh:active { cursor: grabbing; }
.gh-top {
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
}
.gh.sel {
  background: var(--soft);
  border-radius: 4px;
}

.gh-folder {
  flex: none;
  color: var(--muted);
  /* 14px icon + 2px margin fills the --sb-gutter icon slot */
  margin-right: calc(var(--sb-gutter) - 14px);
}

.gh-name {
  font-size: var(--ui-font-size);
  font-weight: 500;
  color: var(--ink);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.gh-path {
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: calc(var(--sb-gutter) + var(--sb-gap));
  font-size: var(--ui-font-size-xs);
}
.gh-add {
  background: transparent;
  border: none;
  color: var(--faint);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* Keep the icon small but give the button a ≥24px tap target. Extra padding
     is vertical only so the right-rail alignment below is preserved. */
  padding: 5px 6px;
  border-radius: 4px;
  flex: none;
  /* Pull the glyph onto the right rail: its right edge lands at --sb-pad-x
     from the sidebar edge, mirroring the folder icon's left gap and lining
     up with the session timestamps below. */
  margin-right: -6px;
}
.gh-add:hover { color: var(--dim); }
.gh-add:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
}

/* More button — hidden until hover */
.gh-more {
  display: none;
  flex: none;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  color: var(--muted);
  border-radius: 4px;
}
.gh:hover .gh-more,
.gh-more.open {
  display: inline-flex;
}
.gh-more:hover,
.gh-more.open { color: var(--ink); background: var(--line2); }
.gh-more:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
  /* Keyboard users can't hover, so the focused kebab must be visible. */
  display: inline-flex;
}

.group-empty {
  padding: 8px 10px 8px calc(var(--sb-pad-x) + var(--sb-gutter) + var(--sb-gap));
  font-size: calc(var(--ui-font-size) - 1.5px);
  color: var(--faint);
  font-family: var(--mono);
}
.show-more {
  display: block;
  width: 100%;
  padding: 6px 10px 6px calc(var(--sb-pad-x) + var(--sb-gutter) + var(--sb-gap));
  background: none;
  border: none;
  color: var(--dim);
  font-size: calc(var(--ui-font-size) - 1.5px);
  font-family: var(--mono);
  cursor: pointer;
  text-align: left;
}
.show-more:hover {
  color: var(--blue2);
  background: var(--soft);
}

/* Inline workspace rename input */
.gh-rename {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  font-weight: 400;
  color: var(--ink);
  background: var(--bg);
  border: 1px solid var(--blue);
  border-radius: 3px;
  padding: 2px 5px;
  outline: none;
}
</style>
