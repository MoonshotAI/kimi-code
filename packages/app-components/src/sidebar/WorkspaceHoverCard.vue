<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { WorkspaceView } from '@moonshot-ai/app-core/client/types';
import { workspaceFolders } from '@moonshot-ai/app-core/client';
import { Icon, Menu } from '@moonshot-ai/app-ui';
import { devicesStore } from '@moonshot-ai/app-client/stores';
import WorkspaceIcon from '../WorkspaceIcon.vue';
import { useDeviceFailureText } from '../composables/useDeviceFailureText';

const props = withDefaults(defineProps<{
  workspace: WorkspaceView;
  canOpen?: boolean;
}>(), { canOpen: false });

const emit = defineEmits<{
  openDirectory: [path: string];
}>();

const { t } = useI18n();
const directories = computed(() => workspaceFolders(props.workspace));
const remote = computed(() => props.workspace.deviceId !== undefined);
const deviceState = computed(() => devicesStore().displayState(props.workspace.deviceId));
const deviceName = computed(() => props.workspace.deviceId === undefined || deviceState.value === 'missing' ? '' : devicesStore().displayName(props.workspace.deviceId));
const failureText = useDeviceFailureText();
const deviceFailure = computed(() => {
  const device = devicesStore().deviceFor(props.workspace.deviceId);
  return deviceState.value === 'failed' ? failureText.label(device?.connectFailure, device?.remoteVersion) : '';
});
</script>

<template>
  <Menu class="workspace-hover-card" data-workspace-hover-card role="dialog" :register="false" :aria-label="workspace.name">
    <div class="whc-head">
      <span class="whc-title">{{ workspace.name }}</span>
    </div>
    <div class="whc-directories">
      <template v-if="remote">
        <div class="whc-directory whc-device">
          <WorkspaceIcon :device-id="workspace.deviceId" status="all" size="sm" />
          <span class="whc-device-copy">
            <span v-if="deviceName" class="whc-device-name" :title="deviceName">{{ deviceName }}</span>
            <span class="whc-device-state" :class="{ failed: deviceState === 'failed' }">{{ t(`workspace.deviceState.${deviceState}`) }}</span>
            <span v-if="deviceFailure" class="whc-device-state">{{ deviceFailure }}</span>
          </span>
        </div>
        <div v-for="directory in directories" :key="directory.path" class="whc-directory whc-directory--static">
          <Icon name="folder" size="sm" />
          <span class="whc-path">{{ directory.path }}</span>
        </div>
      </template>
      <template v-else>
        <button
          v-for="directory in directories"
          :key="directory.path"
          type="button"
          class="whc-directory"
          :disabled="!canOpen"
          :aria-label="t('sidebar.openDirectoryAria', { path: directory.path })"
          @click.stop="emit('openDirectory', directory.path)"
        >
          <Icon name="folder" size="sm" />
          <span class="whc-path">{{ directory.path }}</span>
        </button>
      </template>
    </div>
  </Menu>
</template>

<style scoped>
.workspace-hover-card {
  position: fixed;
  width: max-content;
  z-index: var(--z-dropdown);
  overflow-y: auto;
  overscroll-behavior: contain;
  color: var(--color-text);
  font-family: var(--font-ui);
  user-select: none;
}
.whc-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3) var(--space-1);
}
.whc-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-strong);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}
.whc-directories { display: grid; gap: 0; }
.whc-directory {
  min-width: 0;
  min-height: 26px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  line-height: var(--leading-tight);
  text-align: left;
  cursor: pointer;
}
button.whc-directory:hover:not(:disabled) { background: transparent; color: var(--color-accent); }
.whc-directory:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.whc-directory:disabled { cursor: default; opacity: 1; }
.whc-directory > .kw-icon { flex: none; color: var(--color-text-faint); }
.whc-directory--static { cursor: text; user-select: text; }
.whc-device { cursor: default; font-size: var(--text-xs); }
.whc-device > .ws-icon { color: var(--color-text-faint); }
.whc-device-copy { display: flex; align-items: center; gap: var(--space-1-5); min-width: 0; }
.whc-device-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.whc-device-state { flex: none; color: var(--color-text-faint); }
.whc-device-state:not(:first-child)::before { content: '·'; margin-right: var(--space-1-5); color: var(--color-text-faint); }
.whc-device-state.failed { color: var(--color-danger); }
.whc-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
</style>
