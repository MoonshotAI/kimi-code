<script setup lang="ts">
import { computed, ref, type ComponentPublicInstance, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { WorkspaceGroup, WorkspaceView } from '@moonshot-ai/app-core/client/types';
import SessionRow from './SessionRow.vue';
import { useSessionDrag, usePinnedReturnTarget } from './composables/useSessionDrag';
import { Icon, IconButton, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';
import { hostsStore } from '@moonshot-ai/app-client/stores';
import WorkspaceIcon from './WorkspaceIcon.vue';

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
  sortable?: boolean;
  isCollapsed: (id: string) => boolean;
  visibleLimit: (id: string) => number | undefined;
  flashSessionId?: string | null;
  stateTag?: 'open' | 'done';
  workspaceHoverEnabled?: boolean;
  inPinnedSection?: boolean;
}>();

const emit = defineEmits<{
  groupClick: [workspaceId: string, event: MouseEvent];
  groupContextmenu: [workspace: WorkspaceView, event: MouseEvent];
  toggleWsMenu: [workspace: WorkspaceView, event: MouseEvent];
  createInWorkspace: [workspaceId: string];
  selectSession: [sessionId: string];
  renameSession: [id: string, title: string];
  generateSessionTitle: [id: string, done: (title: string | null) => void];
  archiveSession: [id: string];
  deleteSession: [id: string];
  forkSession: [id: string];
  reloadSession: [id: string];
  exportSession: [id: string];
  pinSession: [id: string];
  dropPinnedSession: [id: string];
  expand: [workspaceId: string];
  collapse: [workspaceId: string];
  confirmRename: [];
  cancelRename: [];
  updateRenameValue: [value: string];
  workspaceHoverStart: [workspace: WorkspaceView, anchor: { right: number; top: number }];
  workspaceHoverEnd: [];
}>();

const renameValueModel = computed<string>({
  get: () => props.renameValue,
  set: (value: string) => emit('updateRenameValue', value),
});

const {
  pinnedDragSession,
  workspaceDragId,
  startSessionRowDrag,
  startWorkspaceDrag,
  endWorkspaceDrag,
} = useSessionDrag();

const isWsDragging = computed(() => workspaceDragId.value === props.group.workspace.id);

const isPinnedDragActive = computed(
  () => !props.inPinnedSection && pinnedDragSession.value !== null,
);
const isPinnedDropTarget = computed(
  () => !props.inPinnedSection && pinnedDragSession.value?.workspaceId === props.group.workspace.id,
);

const {
  dropHover: pinnedDropHover,
  onDragOver: onPinnedDragOver,
  onDrop: onPinnedDrop,
  onDragLeave: onPinnedDragLeave,
} = usePinnedReturnTarget({
  isTarget: () => isPinnedDropTarget.value,
  blockedCursor: true,
  onReturn: (id) => emit('dropPinnedSession', id),
});

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
const canExpand = computed(
  () =>
    props.group.sessions.length > displayLimit.value ||
    props.group.hasMore ||
    props.group.loadingMore,
);
const canCollapse = computed(() => displayLimit.value > props.group.initialCount);

function setRenameInputRef(el: Element | ComponentPublicInstance | null): void {
  props.renameInputRef.value = el instanceof HTMLInputElement ? el : null;
}

const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();
function onRenameEnter(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;
  emit('confirmRename');
}
function onRenameEscape(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;
  emit('cancelRename');
}

const renamingSessionId = ref<string | null>(null);

function onHeaderContextMenu(e: MouseEvent): void {
  if (props.renamingId === props.group.workspace.id) return;
  emit('groupContextmenu', props.group.workspace, e);
}

function onHeaderMouseEnter(event: MouseEvent): void {
  if (!props.workspaceHoverEnabled || props.renamingId === props.group.workspace.id || props.wsMenuOpenId !== null || isWsDragging.value) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  emit('workspaceHoverStart', props.group.workspace, { right: rect.right, top: rect.top });
}

function onHeaderMouseLeave(): void {
  emit('workspaceHoverEnd');
}

function onHeaderDragStart(event: DragEvent): void {
  if (props.sortable === false) return;
  emit('workspaceHoverEnd');
  startWorkspaceDrag(props.group.workspace.id, event);
}
</script>

<template>
  <div
    class="group"
    :class="{
      dragging: isWsDragging,
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
      :class="{
        on: group.workspace.id === activeWorkspaceId && activeId === '',
        collapsed: isCollapsed(group.workspace.id),
        'menu-open': wsMenuOpenId === group.workspace.id,
        'host-unavailable': hostsStore().unavailable(group.workspace.hostId),
      }"
      :draggable="sortable !== false && renamingId !== group.workspace.id"
      @click.stop="emit('groupClick', group.workspace.id, $event)"
      @mouseenter="onHeaderMouseEnter"
      @mouseleave="onHeaderMouseLeave"
      @contextmenu="onHeaderContextMenu"
      @dragstart="onHeaderDragStart"
      @dragend="endWorkspaceDrag()"
    >
      <div class="gh-top">
        <WorkspaceIcon v-if="group.workspace.hostId !== undefined" class="gh-folder" :host-id="group.workspace.hostId" status="all" />
        <Icon v-else-if="isCollapsed(group.workspace.id)" class="gh-folder" name="folder-closed" />
        <Icon v-else class="gh-folder" name="folder" />

        <Tooltip v-if="renamingId !== group.workspace.id && !workspaceHoverEnabled" :text="group.workspace.root">
          <span class="gh-name">{{ group.workspace.name }}</span>
        </Tooltip>
        <span v-else-if="renamingId !== group.workspace.id" class="gh-name">{{ group.workspace.name }}</span>
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
          @blur="emit('confirmRename')"
          @click.stop
        />

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
            :disabled="hostsStore().blocked(group.workspace.hostId)"
            @click.stop="emit('createInWorkspace', group.workspace.id)"
          >
            <Icon name="chat-new" />
          </IconButton>
        </div>
      </div>
    </div>
    <div
      v-if="!hostsStore().unavailable(group.workspace.hostId)"
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
        @dragstart="startSessionRowDrag"
        @rename-state-change="renamingSessionId = $event ? s.id : null"
        @select="emit('selectSession', $event)"
        @rename="(id, title) => emit('renameSession', id, title)"
        @generate-title="(id, done) => emit('generateSessionTitle', id, done)"
        @archive="emit('archiveSession', $event)"
        @delete="emit('deleteSession', $event)"
        @fork="emit('forkSession', $event)"
        @reload="emit('reloadSession', $event)"
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
.group.dragging { opacity: 0.45; }

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


.group-sessions {
  height: auto;
  overflow: hidden;
  transition: height var(--duration-base) var(--ease-out);
}
.group-sessions.collapsed {
  height: 0;
}

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
  cursor: grab;
}
.gh:active { cursor: grabbing; }
.gh:hover { background: var(--sb-hover, var(--color-hover)); }
.gh.on { background: var(--sb-selected, var(--color-selected)); }
.gh.host-unavailable .gh-name { color: var(--color-text-faint); }
.gh-top {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
}

.gh-folder {
  flex: none;
  color: var(--color-text-muted);
}

.gh-name {
  font-size: var(--text-sm);
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

.gh-actions {
  position: absolute;
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
.gh-name {
  --sb-fade: 0px;
  --sb-fade-len: 16px;
  text-overflow: clip;
  -webkit-mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - var(--sb-fade) - var(--sb-fade-len)), transparent calc(100% - var(--sb-fade)));
  mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - var(--sb-fade) - var(--sb-fade-len)), transparent calc(100% - var(--sb-fade)));
}
.gh:hover .gh-name,
.gh:focus-within .gh-name,
.gh.menu-open .gh-name {
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
  padding: var(--space-1) var(--space-2) var(--space-1) calc(var(--sb-pad-x) - var(--sb-inset) + var(--sb-gutter) + var(--sb-gap));
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  user-select: none;
}
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

.gh-rename {
  flex: 1;
  min-width: 0;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-regular);
  color: var(--color-text);
  background: var(--color-bg);
  border: var(--p-hairline) solid var(--color-accent);
  border-radius: var(--radius-xs);
  padding: 2px 5px;
  outline: none;
}

.gh-rename { border-radius: var(--radius-sm); font-family: var(--font-ui); }
.gh-add { color: var(--color-text-quaternary); }
.gh-add:hover { color: var(--color-text-muted); }
</style>

<style scoped src="./lib/locate-flash.css"></style>
