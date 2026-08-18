<!-- apps/web/src/components/chat/WorkspaceHome.vue -->
<!-- Workspace home — the head of the draft (empty-session) landing in the
     status view's workspace flow: folder + workspace name and the root path.
     The centred composer follows; the recent-sessions list
     (WorkspaceRecentSessions) sits below it. Entering this state creates
     nothing — a session only exists once the first prompt is sent.
     (The desktop build also shows native environment actions here —
     open-in-app / native terminal — both bridge-gated; web has neither.) -->
<script setup lang="ts">
import { Icon } from '@moonshot-ai/app-ui';

defineProps<{
  /** Workspace display name. */
  workspaceName?: string;
  /** Absolute workspace root path. */
  workspaceRoot?: string;
}>();
</script>

<template>
  <div class="ws-home">
    <div class="ws-home-title">
      <Icon class="ws-home-folder" name="folder-closed" />
      <span class="ws-home-name">{{ workspaceName }}</span>
    </div>
    <div v-if="workspaceRoot" class="ws-home-path">{{ workspaceRoot }}</div>
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
</style>
