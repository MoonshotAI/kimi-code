<!-- apps/kimi-web/src/components/FileTree.vue -->
<!-- Lazy recursive workspace file tree. Decoupled: no direct API import. -->
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FsEntry } from '../api/types';

const { t } = useI18n();

const props = defineProps<{
  loadDir: (path: string) => Promise<FsEntry[]>;
  changesByPath: Record<string, string>;
  reloadKey?: string | number;
}>();

const emit = defineEmits<{
  select: [entry: FsEntry];
}>();

// ---------------------------------------------------------------------------
// Tree node type (wraps FsEntry with UI state)
// ---------------------------------------------------------------------------

interface TreeNode {
  entry: FsEntry;
  depth: number;
  expanded: boolean;
  loading: boolean;
  children: TreeNode[] | null; // null = not yet loaded
}

// ---------------------------------------------------------------------------
// Root-level state
// ---------------------------------------------------------------------------

const rootNodes = ref<TreeNode[]>([]);
const rootLoading = ref(false);
const rootError = ref(false);
const selectedPath = ref<string | null>(null);

// ---------------------------------------------------------------------------
// Sort: directories first, then files, alphabetical within each group
// ---------------------------------------------------------------------------

function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    const aIsDir = a.kind === 'directory' ? 0 : 1;
    const bIsDir = b.kind === 'directory' ? 0 : 1;
    if (aIsDir !== bIsDir) return aIsDir - bIsDir;
    return a.name.localeCompare(b.name);
  });
}

function entriesToNodes(entries: FsEntry[], depth: number): TreeNode[] {
  return sortEntries(entries).map((entry) => ({
    entry,
    depth,
    expanded: false,
    loading: false,
    children: null,
  }));
}

// ---------------------------------------------------------------------------
// Load root
// ---------------------------------------------------------------------------

async function loadRoot(): Promise<void> {
  rootLoading.value = true;
  rootError.value = false;
  rootNodes.value = [];
  try {
    const items = await props.loadDir('.');
    if (items.length === 0) {
      rootError.value = true;
    } else {
      rootNodes.value = entriesToNodes(items, 0);
    }
  } catch {
    rootError.value = true;
  } finally {
    rootLoading.value = false;
  }
}

// ---------------------------------------------------------------------------
// Expand / collapse a directory node
// ---------------------------------------------------------------------------

async function toggleDir(node: TreeNode): Promise<void> {
  if (node.entry.kind !== 'directory') return;

  if (node.expanded) {
    node.expanded = false;
    return;
  }

  // If children already cached, just expand
  if (node.children !== null) {
    node.expanded = true;
    return;
  }

  // Lazy load
  node.loading = true;
  try {
    const items = await props.loadDir(node.entry.path);
    node.children = entriesToNodes(items, node.depth + 1);
    node.expanded = true;
  } catch {
    node.children = [];
    node.expanded = true;
  } finally {
    node.loading = false;
  }
}

// ---------------------------------------------------------------------------
// File select
// ---------------------------------------------------------------------------

function handleFileClick(node: TreeNode): void {
  selectedPath.value = node.entry.path;
  emit('select', node.entry);
}

// ---------------------------------------------------------------------------
// Node click dispatch
// ---------------------------------------------------------------------------

function handleNodeClick(node: TreeNode): void {
  if (node.entry.kind === 'directory') {
    void toggleDir(node);
  } else {
    handleFileClick(node);
  }
}

// ---------------------------------------------------------------------------
// Flatten tree into visible rows for rendering
// ---------------------------------------------------------------------------

function flatten(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.expanded && node.children) {
      result.push(...flatten(node.children));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Git badge helpers (reuse DiffView patterns)
// ---------------------------------------------------------------------------

type BadgeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'unknown';

function badgeKind(s: string): BadgeKind {
  const lower = s.toLowerCase();
  if (lower === 'modified') return 'modified';
  if (lower === 'added') return 'added';
  if (lower === 'deleted') return 'deleted';
  if (lower === 'renamed') return 'renamed';
  if (lower === 'untracked') return 'untracked';
  return 'unknown';
}

const BADGE_GLYPH: Record<BadgeKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  unknown: '?',
};

function badgeGlyph(s: string): string {
  return BADGE_GLYPH[badgeKind(s)] ?? '?';
}

// ---------------------------------------------------------------------------
// Mount + reload key watcher
// ---------------------------------------------------------------------------

void loadRoot();

watch(
  () => props.reloadKey,
  (newKey, oldKey) => {
    if (newKey !== oldKey) {
      selectedPath.value = null;
      void loadRoot();
    }
  },
);
</script>

<template>
  <div class="file-tree" role="tree" :aria-label="t('fileTree.ariaLabel')">
    <!-- Root loading spinner -->
    <div v-if="rootLoading" class="ft-loading">
      <span class="spinner"></span>
      <span class="ft-loading-text">{{ t('fileTree.loading') }}</span>
    </div>

    <!-- Error / empty state -->
    <div v-else-if="rootError" class="ft-empty">
      {{ t('fileTree.error') }}
    </div>

    <!-- Tree rows -->
    <template v-else>
      <div
        v-for="node in flatten(rootNodes)"
        :key="node.entry.path"
        class="ft-row"
        :class="{
          selected: node.entry.kind !== 'directory' && selectedPath === node.entry.path,
          directory: node.entry.kind === 'directory',
        }"
        :style="{ paddingLeft: `${8 + node.depth * 14}px` }"
        role="treeitem"
        :aria-expanded="node.entry.kind === 'directory' ? node.expanded : undefined"
        :title="node.entry.path"
        @click="handleNodeClick(node)"
      >
        <!-- Expand/collapse glyph for directories -->
        <span v-if="node.entry.kind === 'directory'" class="ft-toggle">
          <span v-if="node.loading" class="spinner-sm"></span>
          <span v-else>{{ node.expanded ? '▾' : '▸' }}</span>
        </span>

        <!-- File icon (folder vs file SVG) -->
        <span class="ft-icon" :class="node.entry.kind === 'directory' ? 'icon-folder' : 'icon-file'">
          <!-- Folder SVG -->
          <svg v-if="node.entry.kind === 'directory'" width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M1 4a1 1 0 0 1 1-1h3.28l1 1.5H12a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4z" stroke="currentColor" stroke-width="1.1" fill="none"/>
          </svg>
          <!-- File SVG -->
          <svg v-else width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M3 1h5.5L11 3.5V13H3V1z" stroke="currentColor" stroke-width="1.1" fill="none"/>
            <path d="M8.5 1v3H11" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>
          </svg>
        </span>

        <!-- Name -->
        <span class="ft-name">{{ node.entry.name }}</span>

        <!-- Git status badge -->
        <span
          v-if="changesByPath[node.entry.path]"
          class="ft-badge"
          :class="badgeKind(changesByPath[node.entry.path]!)"
          :title="changesByPath[node.entry.path]"
        >
          {{ badgeGlyph(changesByPath[node.entry.path]!) }}
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.file-tree {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink);
  background: var(--panel);
  height: 100%;
  overflow-y: auto;
  user-select: none;
}

/* ---- Loading & empty ---- */
.ft-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 20px 16px;
  color: var(--muted);
  font-size: 12px;
}

.ft-loading-text {
  color: var(--muted);
}

.ft-empty {
  padding: 24px 16px;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

/* ---- Tree rows ---- */
.ft-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-top: 3px;
  padding-bottom: 3px;
  padding-right: 8px;
  cursor: pointer;
  line-height: 1.5;
  border-radius: 2px;
  min-width: 0;
}

.ft-row:hover {
  background: var(--panel2);
}

.ft-row.selected {
  background: var(--soft);
  color: var(--blue2);
}

.ft-row.directory {
  color: var(--dim);
}

.ft-row.directory:hover {
  color: var(--ink);
}

/* ---- Toggle glyph ---- */
.ft-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  flex: none;
  color: var(--muted);
  font-size: 9px;
}

/* ---- Icons ---- */
.ft-icon {
  display: inline-flex;
  align-items: center;
  flex: none;
  color: var(--muted);
}

.ft-row.selected .ft-icon {
  color: var(--blue2);
}

.ft-row.directory .ft-icon {
  color: var(--blue);
}

/* ---- Name ---- */
.ft-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: inherit;
}

/* ---- Git badge ---- */
.ft-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 2px;
  font-size: 9px;
  font-weight: 700;
  flex: none;
  user-select: none;
}

.ft-badge.modified  { background: #e8f0fe; color: #1565C0; }
.ft-badge.added     { background: #e6f4ea; color: #1e7e34; }
.ft-badge.deleted   { background: #fce8e6; color: #c5221f; }
.ft-badge.renamed   { background: #fef3e2; color: #b06000; }
.ft-badge.untracked { background: var(--soft); color: var(--muted); }
.ft-badge.unknown   { background: var(--panel2); color: var(--muted); }

/* ---- Spinners ---- */
@keyframes spin { to { transform: rotate(360deg); } }

.spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--line);
  border-top-color: var(--blue);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

.spinner-sm {
  display: inline-block;
  width: 9px;
  height: 9px;
  border: 1.5px solid var(--line);
  border-top-color: var(--blue);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

/* ---- Mobile (≤640px): bigger, finger-friendly rows (≥44px tall) and a larger
        name/icon so the full-width tree is easy to tap. ---- */
@media (max-width: 640px) {
  .file-tree { font-size: 13.5px; }
  .ft-row {
    min-height: 44px;
    gap: 8px;
    padding-top: 0;
    padding-bottom: 0;
    padding-right: 12px;
    border-radius: 0;
    border-bottom: 1px solid var(--line2);
  }
  .ft-row:active { background: var(--panel2); }
  .ft-toggle { width: 18px; font-size: 11px; }
  .ft-name { font-size: 13.5px; }
  .ft-badge { width: 18px; height: 18px; font-size: 10px; }
}
</style>
