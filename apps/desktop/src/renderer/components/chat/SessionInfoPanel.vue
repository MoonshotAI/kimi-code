<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useContextInspector } from '@moonshot-ai/app-core';
import { sessionInfoStore } from '@moonshot-ai/app-client/stores';
import type { PanelTab } from '@moonshot-ai/app-client/composables';
import type { PanelLauncherType } from '@moonshot-ai/app-client/panel';
import SessionInfoContext from './SessionInfoContext.vue';
import SessionInfoFolder from './SessionInfoFolder.vue';
import SessionInfoTabs from './SessionInfoTabs.vue';
import type { SessionInfoMode } from '../../composables/useSessionInfoLayout';
import type { PanelLauncherItem } from '../../lib/panelLauncher';

const props = withDefaults(defineProps<{
  sessionId: string;
  mode: SessionInfoMode;
  ctxUsed?: number;
  ctxMax?: number;
  modelId?: string;
  running?: boolean;
  tabs?: PanelTab[];
  available?: PanelLauncherItem[];
}>(), {
  running: false,
  tabs: () => [],
  available: () => [],
});

const emit = defineEmits<{
  openPr: [url: string];
  openDiff: [root: string];
  activate: [id: string];
  open: [type: PanelLauncherType];
  showTabs: [];
  compact: [];
}>();

const { t } = useI18n();
const { contextInspectorEnabled } = useContextInspector();
const store = sessionInfoStore();
const rows = computed(() => store.rows(props.sessionId));
const contextState = computed(() => store.contextState?.(props.sessionId));
const showFolders = ref(false);
let folderLoadingTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => rows.value.map(row => row.state.status), (statuses) => {
  if (folderLoadingTimer !== undefined) clearTimeout(folderLoadingTimer);
  folderLoadingTimer = undefined;
  showFolders.value = statuses.some(status => status === 'ready' || status === 'error');
  if (showFolders.value || !statuses.includes('loading')) return;
  folderLoadingTimer = setTimeout(() => {
    showFolders.value = true;
    folderLoadingTimer = undefined;
  }, 150);
}, { immediate: true });
onScopeDispose(() => {
  if (folderLoadingTimer !== undefined) clearTimeout(folderLoadingTimer);
});
const folderSignature = computed(() =>
  JSON.stringify(store.foldersForSession(props.sessionId).map(folder => [folder.path, folder.primary])),
);

watch(
  [() => props.sessionId, folderSignature],
  ([sessionId], _previous, onCleanup) => {
    void store.observe(sessionId, store.foldersForSession(sessionId));
    onCleanup(() => store.unobserve(sessionId));
  },
  { immediate: true },
);

watch(
  [() => props.sessionId, contextInspectorEnabled],
  ([sessionId, enabled], _previous, onCleanup) => {
    if (!sessionId || !enabled) return;
    void store.observeContext?.(sessionId);
    onCleanup(() => store.unobserveContext?.(sessionId));
  },
  { immediate: true },
);

watch(
  () => [props.ctxUsed, props.ctxMax, props.modelId, props.running] as const,
  ([used, max, model, running], [prevUsed, prevMax, prevModel, prevRunning]) => {
    if (!props.sessionId || !contextInspectorEnabled.value) return;
    const contextChanged = used !== prevUsed || max !== prevMax || model !== prevModel;
    if (contextChanged || (prevRunning === true && !running)) {
      void store.refreshContext?.(props.sessionId);
    }
  },
);
</script>

<template>
  <aside class="session-info" :class="`is-${mode}`" role="complementary" :aria-label="t('header.sessionInfo')">
    <div v-if="showFolders" class="si-folders">
      <SessionInfoFolder
        v-for="row in rows"
        :key="row.path"
        :row="row"
        :show-primary-badge="rows.length > 1"
        @open-pr="(url) => emit('openPr', url)"
        @open-diff="(root) => emit('openDiff', root)"
      />
    </div>
    <SessionInfoContext
      v-if="sessionId && contextInspectorEnabled"
      :state="contextState"
      :ctx-used="ctxUsed"
      :ctx-max="ctxMax"
      :can-compact="Boolean(sessionId) && !running"
      @compact="emit('compact')"
    />
    <SessionInfoTabs
      :tabs="tabs"
      :available="available"
      @activate="(id) => emit('activate', id)"
      @open="(type) => emit('open', type)"
      @show-tabs="emit('showTabs')"
    />
  </aside>
</template>

<style scoped>
.session-info { box-sizing: border-box; flex: none; min-height: 0; color: var(--color-text); }
.session-info.is-sidebar {
  width: 280px;
  overflow-y: auto;
  border-left: var(--p-hairline) solid var(--color-line);
  background: var(--color-bg);
}
.session-info.is-floating {
  position: absolute;
  z-index: var(--z-sticky);
  top: var(--space-3);
  right: var(--space-3);
  width: 280px;
  max-width: calc(100% - var(--space-6));
  max-height: calc(100% - var(--space-6));
  overflow-y: auto;
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-menu, var(--shadow-sm));
}
.si-folders { position: relative; min-height: 0; padding: var(--space-3) 0 var(--space-4); }
.si-folders::after,
.session-info :deep(.si-context:has(+ .sit .sit-section))::after {
  content: "";
  position: absolute;
  right: var(--space-4);
  bottom: 0;
  left: var(--space-4);
  height: var(--p-hairline);
  background: var(--color-line);
}
</style>
