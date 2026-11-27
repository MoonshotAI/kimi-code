<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FilePreviewRequest } from '@moonshot-ai/app-core/client';
import { isAbsoluteLocalPath, safeGetString, safeSetString } from '@moonshot-ai/app-core/lib';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { useFilePreview } from '@moonshot-ai/app-client/composables';
import { filesStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import { EmptyState, Icon, IconButton, PanelHeader } from '@moonshot-ai/app-ui';
import FilePreview from './FilePreview.vue';
import FileTreePositionMenu from './FileTreePositionMenu.vue';
import FileTreeRootSelect from './FileTreeRootSelect.vue';
import FileTreeSidebar from './FileTreeSidebar.vue';
import FileTreeSidebarFrame from './FileTreeSidebarFrame.vue';
import { useFileStaleness } from './composables/useFileStaleness';
import { useFileTreePosition } from './composables/useFileTreePosition';

const { t } = useI18n();

const client = useKimiWebClient();
const sessionId = computed(() => client.activeSessionId.value || null);
const workspace = computed(() => {
  const id = client.activeWorkspaceId.value;
  return id === null ? undefined : workspacesStore().mergedWorkspaces.find((w) => w.id === id);
});
const cwd = computed(() => workspacesStore().activePanelRoots.root);
const registeredWorkspaceId = computed(() => {
  const id = client.activeWorkspaceId.value;
  return id !== null && workspacesStore().workspaces.some((w) => w.id === id) ? id : undefined;
});
const fileTreeKey = computed(() => {
  if (sessionId.value !== null) return sessionId.value;
  const workspaceId = client.activeWorkspaceId.value;
  if (workspaceId !== null) return `workspace:${workspaceId}`;
  return cwd.value ? `workspace:${cwd.value}` : null;
});
const workspaceName = computed(() => workspace.value?.name ?? cwd.value.split(/[\\/]/).filter(Boolean).at(-1) ?? '');

const treeRoots = computed(() => workspacesStore().activePanelRoots.roots);

const treeRoot = computed(() =>
  filesStore().resolveFileTreeRoot(client.activeWorkspaceId.value, treeRoots.value, cwd.value),
);

function pickTreeRoot(root: string): void {
  filesStore().selectFileTreeRoot(client.activeWorkspaceId.value, treeRoots.value, root, cwd.value);
}

const TREE_OPEN_KEY = 'kimi-web.file-tree-open';
const treeOpen = ref(safeGetString(TREE_OPEN_KEY) !== '0');
watch(treeOpen, (open) => {
  safeSetString(TREE_OPEN_KEY, open ? '1' : '0');
});

const { position: treePosition } = useFileTreePosition();

const previewClient = {
  status: computed(() => ({ ...client.status.value, cwd: cwd.value })),
  getFileDownloadUrl: client.getFileDownloadUrl,
  getSignedFileDownloadUrl: client.getSignedFileDownloadUrl,
  readHostFileContent: client.readHostFileContent,
  readFileContent: async (path: string) => {
    if (sessionId.value !== null) return client.readFileContent(path);
    if (isAbsoluteLocalPath(path)) return client.readHostFileContent(path);
    return client.readHostFileContent(`${cwd.value.replace(/[\\/]+$/, '')}/${path}`);
  },
  readWorkspaceFileBlob: client.readWorkspaceFileBlob,
  openWorkspaceFile: client.openWorkspaceFile,
  revealWorkspaceFile: client.revealWorkspaceFile,
};

const {
  previewTarget,
  previewFile,
  previewLoading,
  previewError,
  previewRefreshing,
  previewDownloadUrl,
  previewExternalActions,
  previewAbsolutePath,
  previewNormalizedPath,
  previewLoadedSeq,
  previewLoadStartedSeq,
  previewMediaUrl,
  openFilePreview,
  closeFilePreview,
  refreshFilePreview,
  openPreviewInEditor,
  revealPreviewFile,
} = useFilePreview({ client: previewClient, t, root: treeRoot });

const staleness = useFileStaleness({ turns: client.turns, sessionId, cwd });
const previewTracker = staleness.createTracker('files-panel-preview', () => {
  const target = previewTarget.value;
  if (!target || typeof target.content === 'string') return [];
  return [previewAbsolutePath.value, previewNormalizedPath.value, target.path];
});
let previewStartMarkers: ReadonlyMap<string, string> | undefined;
watch(previewLoadStartedSeq, () => {
  previewStartMarkers = staleness.markers.value;
});
watch(previewLoadedSeq, () => previewTracker.markLoaded(previewStartMarkers));
watch(previewTarget, (target) => {
  if (target && typeof target.content === 'string') previewTracker.markLoaded();
});

function restorePreview(key: string | null): void {
  if (key === null) return;
  const saved = filesStore().filePreviewTargetOf(key);
  if (saved !== null) void openFilePreview(saved);
}

onMounted(() => {
  restorePreview(fileTreeKey.value);
});

watch([fileTreeKey, treeRoot], ([key, root], [prevKey, prevRoot]) => {
  if (key !== prevKey) {
    closeFilePreview();
    restorePreview(key);
    return;
  }
  if (root !== prevRoot) closeFilePreview();
});

watch(previewTarget, (target) => {
  const key = fileTreeKey.value;
  if (key !== null) filesStore().setFilePreviewTarget(key, target);
});

function onSelectFile(path: string): void {
  void openFilePreview({ path });
}

function onOpenFile(target: FilePreviewRequest): void {
  void openFilePreview(target);
}
</script>

<template>
  <div class="files-panel">
    <EmptyState v-if="fileTreeKey === null" class="files-panel-empty" :title="t('fileTree.noSession')" />
    <template v-else>
      <PanelHeader
        v-if="previewTarget === null"
        :title="workspaceName"
        :title-tooltip="cwd"
        :closable="false"
      >
        <IconButton
          size="sm"
          class="tree-toggle-head"
          :class="{ 'tree-toggle-left': treePosition === 'left' }"
          :pressed="treeOpen"
          :label="treeOpen ? t('fileTree.treeHide') : t('fileTree.treeShow')"
          :tooltip="treeOpen ? t('fileTree.treeHide') : t('fileTree.treeShow')"
          @click="treeOpen = !treeOpen"
        >
          <Icon name="folder-tree" size="md" />
        </IconButton>
        <div class="panel-file-head-actions">
          <FileTreePositionMenu />
        </div>
      </PanelHeader>
      <div v-if="previewTarget === null" class="files-panel-body">
        <EmptyState
          class="files-panel-empty"
          :title="t('fileTree.emptyTitle')"
          :hint="t('fileTree.emptyHint')"
        >
          <template #icon>
            <Icon name="folder-tree" size="lg" />
          </template>
        </EmptyState>
        <FileTreeSidebarFrame
          v-if="treeOpen"
          class="files-panel-aside"
          :class="{ 'files-panel-aside-left': treePosition === 'left' }"
          :position="treePosition"
        >
          <FileTreeRootSelect
            v-if="treeRoots.length > 1"
            :roots="treeRoots"
            :root="treeRoot"
            @select="pickTreeRoot"
          />
          <FileTreeSidebar
            :session-id="sessionId"
            :workspace-id="registeredWorkspaceId"
            :cwd="cwd"
            :root="treeRoots.length > 1 ? treeRoot : undefined"
            :selected-path="previewNormalizedPath"
            @select="onSelectFile"
          />
        </FileTreeSidebarFrame>
      </div>
      <FilePreview
        v-else
        :file="previewFile"
        :loading="previewLoading"
        :error="previewError"
        :line="previewTarget?.line"
        :download-url="previewDownloadUrl"
        :media-url="previewMediaUrl"
        :display-path="previewAbsolutePath ?? undefined"
        :assumed="previewTarget?.assumed === true"
        :closable="true"
        :external-actions="sessionId !== null && previewExternalActions"
        :refreshing="previewRefreshing"
        :stale="previewTracker.stale.value"
        :open-file="onOpenFile"
        :tree-available="true"
        :tree-open="treeOpen"
        :tree-position="treePosition"
        @toggle-tree="treeOpen = !treeOpen"
        @close="closeFilePreview"
        @open-external="openPreviewInEditor"
        @reveal="revealPreviewFile"
        @refresh="refreshFilePreview"
      >
        <template #sidebar>
          <FileTreeSidebarFrame :position="treePosition">
            <FileTreeRootSelect
              v-if="treeRoots.length > 1"
              :roots="treeRoots"
              :root="treeRoot"
              @select="pickTreeRoot"
            />
            <FileTreeSidebar
              :session-id="sessionId"
              :workspace-id="registeredWorkspaceId"
              :cwd="cwd"
              :root="treeRoots.length > 1 ? treeRoot : undefined"
              :selected-path="previewNormalizedPath"
              @select="onSelectFile"
            />
          </FileTreeSidebarFrame>
        </template>
      </FilePreview>
    </template>
  </div>
</template>

<style src="./lib/panel-file-head.css"></style>

<style scoped>
.files-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  container-type: inline-size;
}

.files-panel-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.files-panel-empty {
  flex: 1;
  min-height: 0;
}

.files-panel-aside-left {
  order: -1;
}

.files-panel > .file-preview {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
</style>
