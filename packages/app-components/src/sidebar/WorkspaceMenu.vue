<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { WorkspaceView } from '@moonshot-ai/app-core/client/types';
import { openDeviceSettings } from '@moonshot-ai/app-client/composables';
import { devicesStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import { Icon, Menu, MenuItem } from '@moonshot-ai/app-ui';
import { useAnchoredMenu } from '../composables/useAnchoredMenu';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    canEdit?: boolean;
  }>(),
  { canEdit: false },
);

const emit = defineEmits<{
  pin: [workspace: WorkspaceView];
  copyPath: [workspace: WorkspaceView];
  rename: [workspace: WorkspaceView];
  edit: [workspace: WorkspaceView];
  remove: [workspace: WorkspaceView];
  'update:openId': [id: string | null];
}>();

const store = workspacesStore();
const target = ref<WorkspaceView | null>(null);
const via = ref<'toggle' | 'context'>('toggle');
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const { open, menuStyle, showAnchored, openAt, close } = useAnchoredMenu(menuRef);
const isRemoteTarget = computed(() => target.value?.deviceId !== undefined);
const targetBlocked = computed(() => devicesStore().blocked(target.value?.deviceId));
const canRenameTarget = computed(() => !targetBlocked.value);
const canEditTarget = computed(() => {
  const id = target.value?.id;
  if (!props.canEdit || id === undefined || targetBlocked.value) return false;
  return store.workspaces.some((workspace) => workspace.id === id);
});
const targetPinned = computed(() => {
  const id = target.value?.id;
  return id !== undefined && store.pinnedWorkspaceIds.includes(id);
});

function report(): void {
  emit('update:openId', open.value && via.value === 'toggle' ? (target.value?.id ?? null) : null);
}
watch(open, report);

async function toggle(e: MouseEvent, ws: WorkspaceView): Promise<void> {
  if (open.value && via.value === 'toggle' && target.value?.id === ws.id) {
    close();
    return;
  }
  via.value = 'toggle';
  target.value = ws;
  await showAnchored(e, 'right');
  report();
}

async function openContext(e: MouseEvent, ws: WorkspaceView): Promise<void> {
  via.value = 'context';
  target.value = ws;
  await openAt(e.clientX, e.clientY);
  report();
}

function act(action: 'pin' | 'copyPath' | 'rename' | 'edit' | 'remove'): void {
  const ws = target.value;
  close();
  if (ws === null) return;
  if (action === 'pin') emit('pin', ws);
  else if (action === 'copyPath') emit('copyPath', ws);
  else if (action === 'rename') emit('rename', ws);
  else if (action === 'edit') emit('edit', ws);
  else emit('remove', ws);
}

function openTargetDeviceSettings(): void {
  const deviceId = target.value?.deviceId;
  close();
  if (deviceId !== undefined) openDeviceSettings(deviceId);
}

defineExpose({ toggle, openContext, close });
</script>

<template>
  <Transition name="menu-pop">
    <Menu v-if="open && target" ref="menuRef" class="workspace-menu" :style="menuStyle" @click.stop>
      <MenuItem @click="act('pin')">
        <Icon :name="targetPinned ? 'unpin' : 'pin'" size="sm" />
        {{ targetPinned ? t('sidebar.unpin') : t('sidebar.pin') }}
      </MenuItem>
      <MenuItem @click="act('copyPath')">
        <Icon name="copy" size="sm" />
        {{ t('sidebar.copyPath') }}
      </MenuItem>
      <MenuItem v-if="canRenameTarget" @click="act('rename')">
        <Icon name="pencil" size="sm" />
        {{ t('sidebar.rename') }}
      </MenuItem>
      <MenuItem v-if="canEditTarget" @click="act('edit')">
        <Icon name="sliders" size="sm" />
        {{ t('workspace.dialog.editTitle') }}
      </MenuItem>
      <MenuItem v-if="isRemoteTarget" class="ws-menu-device-settings" @click="openTargetDeviceSettings">
        <Icon name="server" size="sm" />
        {{ t('workspace.deviceNotice.settings') }}
      </MenuItem>
      <MenuItem danger @click="act('remove')">
        <Icon name="close" size="sm" />
        {{ t('sidebar.removeWorkspace') }}
      </MenuItem>
    </Menu>
  </Transition>
</template>

<style scoped>
.workspace-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}
.menu-pop-enter-active {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.menu-pop-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
  pointer-events: none;
}
.menu-pop-enter-from,
.menu-pop-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(var(--menu-pop-shift, -2px));
}
</style>
