<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { WorkspaceView } from '@moonshot-ai/app-core/client/types';
import { workspaceFolders } from '@moonshot-ai/app-core/client';
import { Badge, Icon } from '@moonshot-ai/app-ui';
import { hostsStore } from '@moonshot-ai/app-client/stores';
import WorkspaceIcon from '../WorkspaceIcon.vue';
import { useHostFailureText } from '../composables/useHostFailureText';

const props = withDefaults(defineProps<{
  workspace: WorkspaceView;
  canOpen?: boolean;
}>(), { canOpen: false });

const emit = defineEmits<{
  openDirectory: [path: string];
}>();

const { t } = useI18n();
const directories = computed(() => workspaceFolders(props.workspace));
const remote = computed(() => props.workspace.hostId !== undefined);
const hostState = computed(() => hostsStore().displayState(props.workspace.hostId));
const hostName = computed(() => props.workspace.hostId === undefined || hostState.value === 'missing' ? '' : hostsStore().displayName(props.workspace.hostId));
const failureText = useHostFailureText();
const hostFailure = computed(() => {
  const host = hostsStore().hostFor(props.workspace.hostId);
  return hostState.value === 'failed' ? failureText.label(host?.connectFailure, host?.remoteVersion) : '';
});
</script>

<template>
  <div class="workspace-hover-card" data-workspace-hover-card role="dialog" :aria-label="workspace.name">
    <div class="whc-head">
      <span class="whc-title">{{ workspace.name }}</span>
      <Badge v-if="workspace.kind === 'implicit'" size="sm" variant="neutral">{{ t('workspace.cliBadge') }}</Badge>
    </div>
    <div class="whc-directories">
      <template v-if="remote">
        <div class="whc-directory whc-host">
          <WorkspaceIcon :host-id="workspace.hostId" status="all" size="sm" />
          <span class="whc-host-copy">
            <span v-if="hostName" class="whc-host-name" :title="hostName">{{ hostName }}</span>
            <span class="whc-host-state" :class="{ failed: hostState === 'failed' }">{{ t(`workspace.hostState.${hostState}`) }}</span>
            <span v-if="hostFailure" class="whc-host-state">{{ hostFailure }}</span>
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
  </div>
</template>

<style scoped>
.workspace-hover-card {
  position: fixed;
  width: max-content;
  z-index: var(--z-dropdown);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--space-1);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-menu-bg, var(--color-surface-raised));
  box-shadow: var(--shadow-menu, var(--shadow-sm));
  backdrop-filter: var(--p-menu-backdrop, blur(20px));
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
.whc-host { cursor: default; font-size: var(--text-xs); }
.whc-host > .ws-icon { color: var(--color-text-faint); }
.whc-host-copy { display: flex; align-items: center; gap: var(--space-1-5); min-width: 0; }
.whc-host-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.whc-host-state { flex: none; color: var(--color-text-faint); }
.whc-host-state:not(:first-child)::before { content: '·'; margin-right: var(--space-1-5); color: var(--color-text-faint); }
.whc-host-state.failed { color: var(--color-danger); }
.whc-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
</style>
