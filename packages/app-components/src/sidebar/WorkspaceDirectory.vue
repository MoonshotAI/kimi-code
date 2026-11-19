<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { WorkspaceView } from '@moonshot-ai/app-core/client/types';
import { devicesStore, sessionViewsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import WorkspaceIcon from '../WorkspaceIcon.vue';
import { useWorkspaceRename } from './useWorkspaceRename';
import { Icon, IconButton, useImeComposition } from '@moonshot-ai/app-ui';
import { computed } from 'vue';

const { t } = useI18n();

const props = defineProps<{
  wsMenuOpenId: string | null;
  workspaceHoverEnabled?: boolean;
}>();

const emit = defineEmits<{
  createInWorkspace: [workspaceId: string];
  openMenu: [workspace: WorkspaceView, event: MouseEvent];
  toggleMenu: [workspace: WorkspaceView, event: MouseEvent];
  workspaceHoverStart: [workspace: WorkspaceView, anchor: { right: number; top: number }];
  workspaceHoverEnd: [];
}>();

const sessionViews = sessionViewsStore();
const workspaces = workspacesStore();

const groups = computed(() => sessionViews.workspaceGroups.filter((group) => group.workspace.deviceId === workspaces.deviceScope));
const activeWorkspaceId = computed(() => workspaces.activeWorkspaceId);

const {
  renamingId,
  renameValue,
  renameInputRef,
  confirmRenameWorkspace,
  cancelRenameWorkspace,
} = useWorkspaceRename();

const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

function onDirRenameEnter(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;
  confirmRenameWorkspace();
}

function setRenameInputRef(el: unknown): void {
  renameInputRef.value = el instanceof HTMLInputElement ? el : null;
}

function onWorkspaceMouseEnter(workspace: WorkspaceView, event: MouseEvent): void {
  if (!props.workspaceHoverEnabled || props.wsMenuOpenId !== null || renamingId.value === workspace.id) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  emit('workspaceHoverStart', workspace, { right: rect.right, top: rect.top });
}

function onWorkspaceMouseLeave(): void {
  emit('workspaceHoverEnd');
}
</script>

<template>
  <div
    v-for="g in groups"
    :key="g.workspace.id"
    class="ws-dir"
    :class="{ on: g.workspace.id === activeWorkspaceId, 'device-unavailable': devicesStore().unavailable(g.workspace.deviceId) }"
    @click="emit('createInWorkspace', g.workspace.id); emit('workspaceHoverEnd')"
    @mouseenter="onWorkspaceMouseEnter(g.workspace, $event)"
    @mouseleave="onWorkspaceMouseLeave"
    @contextmenu="emit('openMenu', g.workspace, $event)"
  >
    <div class="ws-dir-row">
      <WorkspaceIcon class="ws-dir-icon" :device-id="g.workspace.deviceId" status="all" />
      <input
        v-if="renamingId === g.workspace.id"
        :ref="setRenameInputRef"
        v-model="renameValue"
        class="ws-dir-rename"
        type="text"
        @keydown.enter.stop="onDirRenameEnter"
        @keydown.esc.stop="cancelRenameWorkspace()"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
        @blur="confirmRenameWorkspace()"
        @click.stop
      />
      <span v-else class="ws-dir-name">{{ g.workspace.name }}</span>
      <span class="ws-dir-act">
        <IconButton
          v-if="renamingId !== g.workspace.id"
          class="gh-more"
          :class="{ open: wsMenuOpenId === g.workspace.id }"
          size="sm"
          :label="t('sidebar.options')"
          :tooltip="t('sidebar.options')"
          aria-haspopup="menu"
          :aria-expanded="wsMenuOpenId === g.workspace.id"
          @click.stop="emit('toggleMenu', g.workspace, $event)"
        >
          <Icon name="dots-horizontal" />
        </IconButton>
      </span>
    </div>
    <div class="ws-dir-sub">{{ g.workspace.root }}</div>
  </div>
  <div v-if="groups.length === 0" class="empty">
    {{ t('workspace.noWorkspace') }}
  </div>
</template>

<style scoped>
.ws-dir {
  display: block;
  padding: 8px calc(var(--sb-pad-x) - var(--sb-inset));
  border-radius: var(--radius-sm);
  cursor: pointer;
  position: relative;
  user-select: none;
}
.ws-dir:hover {
  background: var(--sb-hover, var(--color-hover));
}
.ws-dir.on {
  background: var(--sb-selected, var(--color-selected));
}
.ws-dir + .ws-dir {
  margin-top: var(--space-05);
}
.ws-dir-row {
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
  min-width: 0;
}
.ws-dir-icon {
  flex: none;
  color: var(--color-text-muted);
}
.ws-dir.device-unavailable .ws-dir-name { color: var(--color-text-faint); }
.ws-dir-name {
  flex: 1;
  min-width: 0;
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-caption);
  line-height: var(--leading-tight);
  color: var(--color-text);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: clip;
  -webkit-mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - 16px), transparent);
  mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - 16px), transparent);
}
.ws-dir-act {
  position: absolute;
  top: 0;
  bottom: 0;
  right: var(--sb-action-inset);
  display: inline-flex;
  align-items: center;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--duration-fast) var(--ease-out),
    visibility 0s linear var(--duration-fast);
}
.ws-dir-rename {
  flex: 1;
  min-width: 0;
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-caption);
  color: var(--color-text);
  background: var(--color-bg);
  border: var(--p-hairline) solid var(--color-accent);
  border-radius: var(--radius-sm);
  padding: 2px 5px;
  outline: none;
}
.ws-dir:hover .ws-dir-act,
.ws-dir:focus-within .ws-dir-act {
  opacity: 1;
  visibility: visible;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.ws-dir-sub {
  margin: var(--space-1) 0 0;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: clip;
  -webkit-mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - 16px), transparent);
  mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - 16px), transparent);
}
.ws-dir:hover .ws-dir-name,
.ws-dir:focus-within .ws-dir-name,
.ws-dir:hover .ws-dir-sub,
.ws-dir:focus-within .ws-dir-sub {
  margin-right: calc(var(--icon-button-sm) + var(--space-2));
}

.empty {
  padding: var(--space-6) var(--space-3);
  text-align: center;
  color: var(--faint);
  font-size: calc(var(--ui-font-size) - 3px);
  line-height: 1.6;
}
</style>
