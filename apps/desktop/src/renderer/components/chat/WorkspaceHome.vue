<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, Icon } from '@moonshot-ai/app-ui';
import { WorkspaceIcon } from '@moonshot-ai/app-components/support';
import { OpenInMenu } from '@moonshot-ai/app-components';
import { hostsStore } from '@moonshot-ai/app-client/stores';
import { useNativeTerminal } from '../../composables/useNativeTerminal';

const props = defineProps<{
  workspaceName?: string;
  workspaceRoot?: string;
  workspaceDirs?: string[];
  workspaceHostId?: string;
}>();

const { t } = useI18n();

const remote = computed(() => props.workspaceHostId !== undefined);
const hostLabel = computed(() => props.workspaceHostId === undefined ? '' : hostsStore().hostLabel(props.workspaceHostId, t));
const dirs = computed(() => {
  if (props.workspaceDirs && props.workspaceDirs.length > 0) return props.workspaceDirs;
  return props.workspaceRoot ? [props.workspaceRoot] : [];
});

const terminalStore = useNativeTerminal();

function toggleTerminalPanel(): void {
  terminalStore.toggle(props.workspaceRoot);
}
</script>

<template>
  <div class="ws-home">
    <div class="ws-home-title">
      <WorkspaceIcon class="ws-home-folder" :host-id="workspaceHostId" status="all" />
      <span class="ws-home-name">{{ workspaceName }}</span>
      <span v-if="hostLabel" class="ws-home-host" :title="hostLabel">{{ hostLabel }}</span>
    </div>
    <div v-if="dirs.length > 0" class="ws-home-dirs">
      <div v-for="(dir, i) in dirs" :key="dir" class="ws-home-dir">
        <span class="ws-home-path" :title="dir">{{ dir }}</span>
        <Badge v-if="i === 0 && dirs.length > 1" size="sm" class="ws-home-primary">
          {{ t('workspace.dialog.primaryBadge') }}
        </Badge>
      </div>
    </div>
    <div class="ws-home-actions">
      <OpenInMenu v-if="workspaceRoot && !remote" :work-dir="workspaceRoot" />
      <button
        v-if="terminalStore.available"
        type="button"
        class="ws-home-action"
        :class="{ open: terminalStore.open.value }"
        @click="toggleTerminalPanel"
      >
        <Icon name="terminal" size="sm" />
        <span>{{ terminalStore.open.value ? t('terminal.close') : t('terminal.open') }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.ws-home {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-4) var(--space-4);
  user-select: none;
}
.ws-home-title {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--color-text);
  font-size: var(--ui-t1);
  font-weight: var(--weight-section-label);
}
.ws-home-folder {
  color: var(--color-text-muted);
}
.ws-home-host {
  max-width: 120px;
  overflow: hidden;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-weight: var(--weight-regular);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-home-dirs {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  max-height: 120px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.ws-home-dir {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  max-width: 100%;
  flex: none;
}
.ws-home-path {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-home-primary {
  flex: none;
}
.ws-home-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.ws-home-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 var(--space-3);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-xs);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  cursor: pointer;
  transition:
    background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.ws-home-action:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.ws-home-action:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.ws-home-action.open {
  background: var(--color-well);
  color: var(--color-text);
}
</style>
