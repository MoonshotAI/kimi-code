<!-- apps/desktop/src/renderer/components/chat/WorkspaceHome.vue -->
<!-- Workspace home — the head of the draft (empty-session) landing in the
     status view's workspace flow: folder + workspace name, the root path,
     and the environment actions (open-in-app, native terminal). The centred
     composer follows; the recent-sessions list (WorkspaceRecentSessions)
     sits below it. Entering this state creates nothing — a session only
     exists once the first prompt is sent. -->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { canOpenInNative, listNativeOpenInApps, openInNativeApp } from '../../lib/nativeOpenIn';
import { useNativeTerminal } from '../../composables/useNativeTerminal';
import OpenInMenu from './OpenInMenu.vue';

const props = defineProps<{
  /** Workspace display name. */
  workspaceName?: string;
  /** Absolute workspace root path. */
  workspaceRoot?: string;
}>();

const { t } = useI18n();

// Open-in-app (same bridge-gated catalog as the chat header's): hidden where
// the bridge or the root is missing.
const openInApps = ref<Array<{ id: string; label: string }>>([]);

onMounted(async () => {
  if (canOpenInNative()) {
    openInApps.value = await listNativeOpenInApps();
  }
});

const showOpenIn = computed(() => openInApps.value.length > 0 && Boolean(props.workspaceRoot));

async function onOpenInApp(appId: string): Promise<void> {
  if (!props.workspaceRoot) return;
  await openInNativeApp(appId, props.workspaceRoot);
}

// Native terminal (desktop bridge-gated; hidden on web / old bridges). The
// panel is keyed by cwd, so a draft workspace gets its own terminal.
const terminalStore = useNativeTerminal();

function toggleTerminalPanel(): void {
  terminalStore.toggle(props.workspaceRoot);
}
</script>

<template>
  <div class="ws-home">
    <div class="ws-home-title">
      <Icon class="ws-home-folder" name="folder-closed" />
      <span class="ws-home-name">{{ workspaceName }}</span>
    </div>
    <div v-if="workspaceRoot" class="ws-home-path">{{ workspaceRoot }}</div>
    <div class="ws-home-actions">
      <OpenInMenu
        v-if="showOpenIn"
        :work-dir="workspaceRoot ?? ''"
        :available-apps="openInApps"
        @open-in-app="onOpenInApp"
      />
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
.ws-home-path {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-home-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
/* Chip matching the OpenInMenu pill's geometry (26px, hairline, raised). */
.ws-home-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 var(--space-3);
  border: 0.5px solid var(--color-line);
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
