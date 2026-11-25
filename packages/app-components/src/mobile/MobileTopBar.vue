<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { WorkspaceView } from '@moonshot-ai/app-core/client/types';
import type { SessionDisplayStatus } from '@moonshot-ai/app-core/lib';
import { Badge, Icon, IconButton, Spinner, StatusDot } from '@moonshot-ai/app-ui';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    workspace: WorkspaceView | null;
    sessionTitle?: string;
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
        <StatusDot v-else-if="status === 'unread'" status="unread" />
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
  height: calc(50px + var(--safe-top));
  flex: none;
  padding: var(--safe-top) max(12px, var(--safe-right)) 0 max(12px, var(--safe-left));
  border-bottom: var(--p-hairline) solid var(--color-line);
  background: var(--color-topbar-bg-frost);
  -webkit-backdrop-filter: var(--p-topbar-backdrop);
  backdrop-filter: var(--p-topbar-backdrop);
  font-family: var(--font-ui);
  -webkit-user-select: none;
  user-select: none;
}

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

.tb-line {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: max(16px, var(--text-lg));
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
</style>
