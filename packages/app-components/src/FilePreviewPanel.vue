<script setup lang="ts">
import { ref, watch } from 'vue';
import type { FileData, FilePreviewRequest } from '@moonshot-ai/app-core/client/types';
import { safeGetString, safeSetString } from '@moonshot-ai/app-core/lib';
import FilePreview from './FilePreview.vue';
import FileTreeRootSelect from './FileTreeRootSelect.vue';
import FileTreeSidebar from './FileTreeSidebar.vue';
import FileTreeSidebarFrame from './FileTreeSidebarFrame.vue';
import { useFileTreePosition } from './composables/useFileTreePosition';

export interface FilePreviewPanelPreview {
  file: FileData | null;
  loading: boolean;
  error?: string | null;
  line?: number;
  downloadUrl?: string | null;
  mediaUrl?: string | null;
  displayPath?: string;
  closable?: boolean;
  externalActions?: boolean;
  assumed?: boolean;
  stale?: boolean;
  refreshing?: boolean;
  openFile?: (target: FilePreviewRequest) => void;
  onClose?: () => void;
  onOpenExternal?: () => void;
  onReveal?: () => void;
  onRefresh?: () => void;
}

export interface FilePreviewPanelTree {
  available: boolean;
  sessionId: string | null;
  roots: readonly string[];
  root: string;
  cwd: string;
  selectedPath: string | null;
  onSelectRoot: (root: string) => void;
  onSelectFile: (path: string) => void;
}

const TREE_OPEN_KEY = 'kimi-web.file-tree-open';

defineProps<{
  preview: FilePreviewPanelPreview;
  tree: FilePreviewPanelTree;
}>();

const treeOpen = ref(safeGetString(TREE_OPEN_KEY) === '1');

watch(treeOpen, (open) => {
  safeSetString(TREE_OPEN_KEY, open ? '1' : '0');
});

const { position: treePosition } = useFileTreePosition();
</script>

<template>
  <FilePreview
    v-bind="preview"
    :tree-available="tree.available && tree.sessionId !== null"
    :tree-open="treeOpen && tree.sessionId !== null"
    :tree-position="treePosition"
    @toggle-tree="treeOpen = !treeOpen"
  >
    <template v-if="tree.sessionId" #sidebar>
      <FileTreeSidebarFrame :position="treePosition">
        <FileTreeRootSelect
          v-if="tree.roots.length > 1"
          :roots="tree.roots"
          :root="tree.root"
          @select="tree.onSelectRoot"
        />
        <FileTreeSidebar
          :session-id="tree.sessionId"
          :cwd="tree.cwd"
          :root="tree.roots.length > 1 ? tree.root : undefined"
          :selected-path="tree.selectedPath"
          @select="tree.onSelectFile"
        />
      </FileTreeSidebarFrame>
    </template>
  </FilePreview>
</template>
