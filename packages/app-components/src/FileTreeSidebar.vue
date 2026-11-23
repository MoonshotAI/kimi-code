<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FsEntry } from '@moonshot-ai/app-core/api';
import type { FileItem } from '@moonshot-ai/app-core/client';
import { fileTypeIcon, pathDirname } from '@moonshot-ai/app-core/lib';
import { filesStore } from '@moonshot-ai/app-client/stores';
import { Button, Icon, IconButton, Input, MenuItem, ScrollArea, Spinner } from '@moonshot-ai/app-ui';
import FileTree from './FileTree.vue';
import { openFileContextMenu } from './chat/fileContextMenu';

const { t } = useI18n();

const props = defineProps<{
  sessionId: string | null;
  workspaceId?: string;
  cwd: string;
  root?: string;
  selectedPath: string | null;
}>();

const emit = defineEmits<{
  select: [path: string];
}>();

const store = filesStore();

const NO_EXPANDED: Record<string, boolean> = {};

const treeBase = computed(() =>
  props.root !== undefined && props.root !== props.cwd ? props.root : '.',
);
const treeCwd = computed(() => (treeBase.value === '.' ? props.cwd : treeBase.value));
const treeKey = computed(() => props.sessionId ?? `workspace:${treeCwd.value}`);
const workspaceScope = computed(() =>
  props.sessionId === null ? { workspaceId: props.workspaceId, root: treeCwd.value } : undefined,
);
const treeState = computed(() => store.fileTreeBySession[treeKey.value]);
const expanded = computed(() => {
  const raw = treeState.value?.expanded;
  if (raw === undefined || treeBase.value === '.') return raw ?? NO_EXPANDED;
  const prefix = `${treeBase.value}/`;
  const mapped: Record<string, boolean> = {};
  for (const [p, on] of Object.entries(raw)) {
    if (p.startsWith(prefix)) mapped[p.slice(prefix.length)] = on;
  }
  return mapped;
});
const anyLoading = computed(() => Object.values(treeState.value?.loading ?? {}).some(Boolean));
const rootFailed = computed(() => treeState.value?.failed[treeBase.value] === true);

function toStorePath(path: string): string {
  return treeBase.value === '.' || path === treeBase.value ? path : `${treeBase.value}/${path}`;
}

function childrenOf(path: string): FsEntry[] | undefined {
  return treeState.value?.children[toStorePath(path)];
}

function loadingOf(path: string): boolean {
  return treeState.value?.loading[toStorePath(path)] === true;
}

function failedOf(path: string): boolean {
  return treeState.value?.failed[toStorePath(path)] === true;
}

function ensureRoot(): void {
  const state = store.fileTreeBySession[treeKey.value];
  if (state === undefined || state.children[treeBase.value] === undefined) {
    void store.loadFileTreeChildren(treeKey.value, treeBase.value, workspaceScope.value);
  }
}

function refresh(): void {
  if (treeBase.value === '.') {
    void store.refreshFileTree(treeKey.value, workspaceScope.value);
    return;
  }
  void store.refreshFileTree(treeKey.value, workspaceScope.value).then(() => {
    if (treeBase.value !== '.') {
      void store.loadFileTreeChildren(treeKey.value, treeBase.value, workspaceScope.value);
    }
  });
}

function retryRoot(): void {
  void store.loadFileTreeChildren(treeKey.value, treeBase.value, workspaceScope.value);
}

function onToggle(path: string): void {
  void store.toggleFileTreeDir(treeKey.value, toStorePath(path), workspaceScope.value);
}

function onRetry(path: string): void {
  void store.loadFileTreeChildren(treeKey.value, toStorePath(path), workspaceScope.value);
}

function onSelect(path: string): void {
  emit('select', toStorePath(path));
}

const query = ref('');
const debouncedQuery = ref('');
const results = ref<FileItem[]>([]);
const searching = ref(false);
const searchActive = computed(() => debouncedQuery.value !== '');
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let searchSeq = 0;

watch(query, (value) => {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    debouncedQuery.value = value.trim();
  }, 300);
});

watch(debouncedQuery, async (value) => {
  if (value === '') {
    results.value = [];
    searching.value = false;
    return;
  }
  const seq = ++searchSeq;
  searching.value = true;
  try {
    const items = await store.searchFiles(value, { root: treeCwd.value });
    if (seq === searchSeq) results.value = items.filter((item) => item.kind !== 'directory');
  } finally {
    if (seq === searchSeq) searching.value = false;
  }
});

function resultDir(path: string): string {
  return pathDirname(path);
}

function pickResult(path: string): void {
  query.value = '';
  emit('select', toStorePath(path));
}

watch(
  () => [treeKey.value, treeBase.value],
  () => {
    query.value = '';
    debouncedQuery.value = '';
    results.value = [];
    searchSeq += 1;
    ensureRoot();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  searchSeq += 1;
});
</script>

<template>
  <div class="file-tree-sidebar">
    <div class="fts-head">
      <Input v-model="query" size="sm" :placeholder="t('fileTree.searchPlaceholder')" />
      <IconButton
        size="sm"
        :label="t('fileTree.refresh')"
        :tooltip="t('fileTree.refresh')"
        :disabled="anyLoading"
        @click="refresh"
      >
        <Spinner v-if="anyLoading" size="xs" />
        <Icon v-else name="refresh" size="md" />
      </IconButton>
    </div>
    <div v-if="rootFailed && !searchActive" class="fts-error">
      <span>{{ t('fileTree.loadError') }}</span>
      <Button variant="secondary" size="xs" @click="retryRoot">{{ t('fileTree.retry') }}</Button>
    </div>
    <ScrollArea class="fts-body">
      <FileTree
        v-if="!searchActive"
        :children-of="childrenOf"
        :loading-of="loadingOf"
        :failed-of="failedOf"
        :expanded="expanded"
        :selected-path="selectedPath"
        :cwd="treeCwd"
        :root-path="treeBase"
        @toggle="onToggle"
        @select="onSelect"
        @retry="onRetry"
      />
      <div v-else class="fts-results" @contextmenu="openFileContextMenu($event, treeCwd)">
        <div v-if="searching" class="fts-hint"><Spinner size="sm" /></div>
        <template v-else-if="results.length > 0">
          <MenuItem
            v-for="item in results"
            :key="item.path"
            role="button"
            :data-file-path="item.path"
            @click="pickResult(item.path)"
          >
            <Icon :name="fileTypeIcon(item.name)" size="sm" />
            <span class="fts-result-name">{{ item.name }}</span>
            <span v-if="resultDir(item.path) !== ''" class="fts-result-dir">{{ resultDir(item.path) }}</span>
          </MenuItem>
        </template>
        <div v-else class="fts-hint">{{ t('fileTree.noResults') }}</div>
      </div>
    </ScrollArea>
  </div>
</template>

<style scoped>
.file-tree-sidebar {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.fts-head {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-2);
  flex: none;
}

.fts-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2) var(--space-2);
  color: var(--color-danger);
  font-size: var(--text-xs);
  flex: none;
}

.fts-body {
  flex: 1;
  min-height: 0;
}

.fts-results {
  padding: var(--space-1);
}

.fts-result-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fts-result-dir {
  min-width: 0;
  max-width: 45%;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}

.fts-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4) var(--space-2);
  color: var(--muted);
  font-size: var(--text-xs);
}
</style>
