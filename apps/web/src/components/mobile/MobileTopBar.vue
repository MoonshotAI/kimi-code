<!-- Mobile title bar (50px + safe-top), frosted glass — the design system's -->
<!-- sole glassmorphism exception, reserved for sticky nav bars (§03 TopBar -->
<!-- .frost). One full-height tap target opens the switcher sheet: an optional -->
<!-- leading status (the session's ONE display status — approval/question pill, -->
<!-- running spinner, unread dot — same precedence as sidebar rows) ahead of a -->
<!-- single vertically-centred `workspace / session ⌄` line. The trailing -->
<!-- sliders button opens the settings sheet. Terminal Pro styling, no emoji. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { WorkspaceView } from '../../types';
import type { SessionDisplayStatus } from '@moonshot-ai/app-core/lib';
import { Badge, Icon, IconButton, Spinner } from '@moonshot-ai/app-ui';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    /** Active workspace (the left, quiet side of the path line). */
    workspace: WorkspaceView | null;
    /** Active session title (the right, strong side of the path line). */
    sessionTitle?: string;
    /** The active session's one display status (idle renders nothing). */
    status?: SessionDisplayStatus;
  }>(),
  { workspace: null, sessionTitle: '', status: 'idle' },
);

const emit = defineEmits<{
  openSwitcher: [];
  openSettings: [];
}>();

const wsName = computed<string>(() => props.workspace?.name ?? t('workspace.noWorkspace'));
</script>

<template>
  <div class="topbar">
    <button
      type="button"
      class="tb-main"
      :aria-label="t('mobile.openSwitcher')"
      @click="emit('openSwitcher')"
    >
      <span v-if="status !== 'idle'" class="st" aria-hidden="true">
        <Badge v-if="status === 'awaiting-approval'" variant="warning" size="sm">{{ t('workspace.awaitingPermission') }}</Badge>
        <Badge v-else-if="status === 'awaiting-question'" variant="info" size="sm">{{ t('workspace.awaitingAnswer') }}</Badge>
        <Spinner v-else-if="status === 'running'" size="sm" />
        <Badge v-else-if="status === 'aborted'" variant="danger" size="sm">{{ t('workspace.aborted') }}</Badge>
        <span v-else-if="status === 'unread'" class="unread-dot" />
      </span>
      <span class="tb-line">
        <span class="dir" :class="{ solo: !sessionTitle }">{{ wsName }}</span>
        <template v-if="sessionTitle">
          <span class="sl">/</span>
          <span class="tt">{{ sessionTitle }}</span>
        </template>
        <Icon class="cv" name="chevron-down" size="sm" />
      </span>
    </button>

    <IconButton
      size="lg"
      :label="t('mobile.openSettings')"
      @click="emit('openSettings')"
    >
      <Icon name="sliders" size="lg" />
    </IconButton>
  </div>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  /* Grow the bar by the top inset so the 50px content row stays below the
     status bar / notch in standalone PWA mode and landscape. */
  height: calc(50px + var(--safe-top));
  flex: none;
  padding: var(--safe-top) max(12px, var(--safe-right)) 0 max(12px, var(--safe-left));
  border-bottom: 0.5px solid var(--color-line);
  /* Frosted glass, the §03 TopBar .frost token recipe — content scrolling
     underneath reads through like a native nav bar. */
  background: var(--color-topbar-bg-frost);
  -webkit-backdrop-filter: var(--p-topbar-backdrop);
  backdrop-filter: var(--p-topbar-backdrop);
  font-family: var(--font-ui);
  -webkit-user-select: none;
  user-select: none;
}

/* Switcher tap target: status + path line, the full row height. */
.tb-main {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: 4px;
  padding: 0 6px 0 0;
  background: none;
  border: none;
  border-radius: var(--radius-md);
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.tb-main:active {
  opacity: 0.55;
}

.st {
  flex: none;
  display: inline-flex;
  align-items: center;
}

/* Single centred line: quiet workspace, strong session, faint chevron. */
.tb-line {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: max(16px, var(--ui-font-size-xl));
  line-height: 1.25;
  white-space: nowrap;
}
.tb-line .dir {
  flex: none;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-text-faint);
}
/* No session: the workspace name IS the title. */
.tb-line .dir.solo {
  max-width: none;
  min-width: 0;
  color: var(--color-text);
  font-weight: var(--weight-semibold);
}
.tb-line .sl {
  flex: none;
  color: var(--color-text-faint);
}
.tb-line .tt {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-text);
  font-weight: var(--weight-semibold);
}
.tb-line .cv {
  flex: none;
  align-self: center;
  color: var(--color-text-faint);
}

/* Same dot as the sidebar rows. */
.unread-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
}
</style>
