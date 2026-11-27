<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useContextInspector } from '@moonshot-ai/app-core/composables';
import { Icon, IconButton, Spinner } from '@moonshot-ai/app-ui';
import { sessionInfoStore, sessionsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import { SessionInfoPopover, sessionWorktreeDisplay, type CompactPhase } from '@moonshot-ai/app-components/support';
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
  hasMessages?: boolean;
  compactPhase?: CompactPhase;
  tabs?: PanelTab[];
  available?: PanelLauncherItem[];
}>(), {
  running: false,
  hasMessages: true,
  compactPhase: 'idle',
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
  showFolders.value = statuses.some(status => status !== 'loading');
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

const session = computed(() => sessionsStore().sessions.find(item => item.id === props.sessionId));
const worktree = computed(() => sessionWorktreeDisplay(session.value));
const home = computed(() => (session.value?.hostId === undefined ? workspacesStore().fsHome : null));
const projectName = computed(() => {
  const current = session.value;
  if (current === undefined || worktree.value === null) return null;
  const workspaces = workspacesStore();
  const id = workspaces.workspaceIdForSession(current);
  return workspaces.mergedWorkspaces.find((item) => item.id === id)?.name ?? null;
});
const primaryStatus = computed(() => rows.value.find(row => row.primary)?.state.status);
const primaryMissing = computed(() => worktree.value?.missing === true || primaryStatus.value === 'missing');
const refreshing = computed(() => store.refreshing(props.sessionId));
const refreshError = computed(() => store.refreshError(props.sessionId));

function refresh(): void {
  void store.refresh(props.sessionId);
}

watch(
  () => [props.sessionId, session.value?.worktree?.missing === true] as const,
  ([sessionId, missing], [previousSessionId, previousMissing]) => {
    if (sessionId !== previousSessionId || missing === previousMissing) return;
    const known = primaryStatus.value;
    if (known === undefined || known === 'loading' || missing === (known === 'missing')) return;
    void store.refresh(sessionId);
  },
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
  () => [props.ctxUsed, props.ctxMax, props.modelId, props.running, props.compactPhase] as const,
  ([used, max, model, running, phase], [prevUsed, prevMax, prevModel, prevRunning, prevPhase]) => {
    if (!props.sessionId || !contextInspectorEnabled.value) return;
    const contextChanged = used !== prevUsed || max !== prevMax || model !== prevModel;
    const settled = (prevRunning === true && !running) || (prevPhase === 'compacting' && phase !== 'compacting');
    if (contextChanged || settled) {
      void store.refreshContext?.(props.sessionId);
    }
  },
);
</script>

<template>
  <aside class="session-info" :class="`is-${mode}`" role="complementary" :aria-label="t('header.sessionInfo')">
    <div class="si-body">
      <div v-if="showFolders" class="si-folders">
        <SessionInfoFolder
          v-for="row in rows"
          :key="row.path"
          :row="row"
          :worktree="worktree"
          :home="home"
          :label="row.primary ? projectName : null"
          :refreshing="refreshing"
          @open-pr="(url) => emit('openPr', url)"
          @open-diff="(root) => emit('openDiff', root)"
          @retry="refresh"
        >
          <template v-if="row.primary" #heading-action>
            <SessionInfoPopover
              v-if="refreshError"
              class="si-refresh-error"
              :title="t('worktreeSession.refreshErrorTitle')"
              :body="t('worktreeSession.refreshErrorBody')"
              :output="refreshError.output"
              :busy="refreshing"
              @retry="refresh"
            />
            <IconButton
              v-else
              class="si-refresh"
              :class="{ spinning: refreshing }"
              size="sm"
              :label="t('worktreeSession.refresh')"
              :tooltip="t('worktreeSession.refresh')"
              :aria-busy="refreshing"
              @click="refresh"
            >
              <Spinner v-if="refreshing" size="sm" />
              <Icon v-else name="refresh" size="sm" />
            </IconButton>
          </template>
        </SessionInfoFolder>
      </div>
      <SessionInfoContext
        v-if="sessionId && contextInspectorEnabled"
        :state="contextState"
        :ctx-used="ctxUsed"
        :ctx-max="ctxMax"
        :can-compact="Boolean(sessionId) && hasMessages"
        :compact-phase="compactPhase"
        @compact="emit('compact')"
      />
      <SessionInfoTabs
        :tabs="tabs"
        :available="available"
        :browser-only="primaryMissing"
        @activate="(id) => emit('activate', id)"
        @open="(type) => emit('open', type)"
        @show-tabs="emit('showTabs')"
      />
    </div>
  </aside>
</template>

<style scoped>
.session-info { box-sizing: border-box; flex: none; min-height: 0; color: var(--color-text); }
.session-info.is-sidebar {
  width: 280px;
  overflow-x: hidden;
  overflow-y: auto;
  border-left: var(--p-hairline) solid var(--color-line);
  background: var(--color-bg);
}
.session-info.is-sidebar > .si-body { width: calc(280px - var(--p-hairline)); }
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
.si-refresh { opacity: 0; transition: opacity var(--duration-fast) var(--ease-out); }
.session-info:hover .si-refresh,
.si-refresh:focus-visible,
.si-refresh.spinning { opacity: 1; }
@media (hover: none) {
  .si-refresh { opacity: 1; }
}
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
