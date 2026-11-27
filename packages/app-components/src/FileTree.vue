<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FsEntry } from '@moonshot-ai/app-core/api';
import { copyTextToClipboard, fileTypeIcon, isWindowsPath } from '@moonshot-ai/app-core/lib';
import { RevealInFolderKey, InsertPathMentionKey } from '@moonshot-ai/app-client/contracts';
import { useWarningsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import { Button, Icon, IconButton, Menu, MenuItem, Spinner } from '@moonshot-ai/app-ui';
import { useAnchoredMenu } from './composables/useAnchoredMenu';
import { openFileContextMenu } from './chat/fileContextMenu';
import { absoluteFilePath } from './lib/displayPath';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    childrenOf: (path: string) => FsEntry[] | undefined;
    loadingOf: (path: string) => boolean;
    failedOf: (path: string) => boolean;
    expanded: Record<string, boolean>;
    selectedPath: string | null;
    cwd?: string;
    rootPath?: string;
  }>(),
  { rootPath: '.' },
);

const emit = defineEmits<{
  toggle: [path: string];
  select: [path: string];
  retry: [path: string];
}>();

interface FlatRow {
  entry: FsEntry | null;
  depth: number;
  key: string;
  errorPath?: string;
}

function isDirectoryEntry(entry: FsEntry): boolean {
  return entry.kind === 'directory' || entry.isDirectory === true;
}

const flatRows = computed<FlatRow[]>(() => {
  const rows: FlatRow[] = [];
  const walk = (path: string, depth: number): void => {
    const children = props.childrenOf(path);
    if (children === undefined) {
      if (path !== props.rootPath && props.failedOf(path)) rows.push({ entry: null, depth, key: `error:${path}`, errorPath: path });
      return;
    }
    if (path !== props.rootPath && props.failedOf(path)) rows.push({ entry: null, depth, key: `error:${path}`, errorPath: path });
    if (children.length === 0) {
      rows.push({ entry: null, depth, key: `empty:${path}` });
      return;
    }
    for (const entry of children) {
      rows.push({ entry, depth, key: `entry:${entry.path}` });
      if (isDirectoryEntry(entry) && props.expanded[entry.path] === true) {
        walk(entry.path, depth + 1);
      }
    }
  };
  walk(props.rootPath, 0);
  return rows;
});

function treeRowStyle(depth: number): Record<string, string> {
  return {
    paddingLeft: `calc(var(--tree-base-indent) + ${depth} * var(--tree-indent-step))`,
    '--tree-depth': String(depth),
  };
}

function onRowClick(entry: FsEntry): void {
  if (isDirectoryEntry(entry)) emit('toggle', entry.path);
  else emit('select', entry.path);
}

function isSelected(path: string): boolean {
  const selected = props.selectedPath;
  if (selected === null) return false;
  return props.cwd !== undefined && isWindowsPath(props.cwd)
    ? path.toLowerCase() === selected.toLowerCase()
    : path === selected;
}

function onRowKeydown(event: KeyboardEvent, entry: FsEntry): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  onRowClick(entry);
}

function onRetry(row: FlatRow): void {
  if (row.errorPath !== undefined) emit('retry', row.errorPath);
}

const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const { open: menuOpen, menuStyle, showAnchored, close: closeMenu } = useAnchoredMenu(menuRef);
const menuEntry = ref<FsEntry | null>(null);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

const revealInFolder = inject(RevealInFolderKey, undefined);
const insertPathMention = inject(InsertPathMentionKey, undefined);
const warningsStore = useWarningsStore();

function addRowToChat(): void {
  const entry = menuEntry.value;
  closeMenu();
  if (entry) {
    const path = props.rootPath === '.' ? entry.path : absoluteFilePath({ path: entry.path, cwd: props.cwd });
    insertPathMention?.(path, isDirectoryEntry(entry) ? 'folder' : 'file');
  }
}

async function onRowMenu(event: MouseEvent, entry: FsEntry): Promise<void> {
  if (menuOpen.value && menuEntry.value?.path === entry.path) {
    closeMenu();
    return;
  }
  menuEntry.value = entry;
  copied.value = false;
  await showAnchored(event, 'right');
}

function menuTargetPath(): string {
  const entry = menuEntry.value;
  if (!entry) return '';
  return absoluteFilePath({ path: entry.path, cwd: props.cwd });
}

async function copyRowPath(): Promise<void> {
  const path = menuTargetPath();
  if (!path) {
    closeMenu();
    return;
  }
  const ok = await copyTextToClipboard(path);
  if (!ok) {
    closeMenu();
    warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.copyFailed') });
    return;
  }
  copied.value = true;
  if (copiedTimer !== null) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = false;
    closeMenu();
  }, 1400);
}

async function revealRow(): Promise<void> {
  const path = menuTargetPath();
  closeMenu();
  if (revealInFolder === undefined || !path) return;
  const ok = await revealInFolder(path);
  if (!ok) warningsStore.pushWarning({ severity: 'error', title: t('mediaPreview.revealFailed') });
}

onBeforeUnmount(() => {
  if (copiedTimer !== null) clearTimeout(copiedTimer);
});
</script>

<template>
  <div class="file-tree" @contextmenu="openFileContextMenu($event, cwd)">
    <TransitionGroup name="tree-collapse" tag="ul" class="tree-list">
      <li v-for="row in flatRows" :key="row.key" class="tree-node">
        <div
          v-if="row.entry"
          class="tree-row"
          :class="{ 'is-selected': isSelected(row.entry.path), 'is-folder': isDirectoryEntry(row.entry) }"
          :style="treeRowStyle(row.depth)"
          role="button"
          tabindex="0"
          :data-file-path="row.entry.path"
          :data-file-kind="isDirectoryEntry(row.entry) ? 'folder' : 'file'"
          :data-file-symlink="row.entry.kind === 'symlink' ? '' : undefined"
          @click="onRowClick(row.entry)"
          @keydown="onRowKeydown($event, row.entry)"
        >
          <Spinner v-if="isDirectoryEntry(row.entry) && loadingOf(row.entry.path)" size="xs" class="tree-lead tree-spinner" />
          <Icon
            v-else-if="isDirectoryEntry(row.entry)"
            class="tree-lead"
            :name="expanded[row.entry.path] === true ? 'chevron-down' : 'chevron-right'"
            size="sm"
          />
          <Icon v-else class="tree-lead" :name="fileTypeIcon(row.entry.name)" size="sm" />
          <span class="tree-name">{{ row.entry.name }}</span>
          <Icon
            v-if="row.entry.kind === 'symlink'"
            class="tree-symlink"
            :name="isDirectoryEntry(row.entry) ? 'folder-symlink' : 'file-symlink'"
            size="sm"
            :label="isDirectoryEntry(row.entry) ? t('fileTree.symlinkFolder') : t('fileTree.symlinkFile')"
          />
          <IconButton
            class="tree-more"
            size="sm"
            :label="t('filePreview.moreActions')"
            @click.stop="onRowMenu($event, row.entry)"
            @keydown.stop
          >
            <Icon name="dots-horizontal" size="md" />
          </IconButton>
        </div>
        <div v-else-if="row.errorPath !== undefined" class="tree-row is-error" :style="treeRowStyle(row.depth)">
          <span class="tree-error-text">{{ t('fileTree.loadError') }}</span>
          <Button variant="secondary" size="xs" @click.stop="onRetry(row)">{{ t('fileTree.retry') }}</Button>
        </div>
        <div v-else class="tree-row is-empty" :style="treeRowStyle(row.depth)">{{ t('fileTree.emptyDir') }}</div>
      </li>
    </TransitionGroup>
    <Teleport to="body">
      <Menu
        v-if="menuOpen"
        ref="menuRef"
        class="ui-menu-floating tree-menu"
        :style="menuStyle"
        @click.stop
        @contextmenu.prevent
      >
        <MenuItem v-if="insertPathMention !== undefined" @click="addRowToChat">
          <Icon name="at" size="sm" />
          {{ t('selection.addToChat') }}
        </MenuItem>
        <MenuItem @click="copyRowPath">
          <Icon :name="copied ? 'check' : 'copy'" size="sm" />
          {{ copied ? t('fileTree.copied') : t('fileTree.copyPath') }}
        </MenuItem>
        <MenuItem v-if="revealInFolder !== undefined && workspacesStore().isLocalWorkspace" @click="revealRow">
          <Icon name="folder" size="sm" />
          {{ t('fileTree.reveal') }}
        </MenuItem>
      </Menu>
    </Teleport>
  </div>
</template>

<style scoped>
.file-tree {
  --tree-base-indent: var(--file-tree-base-indent);
  --tree-indent-step: var(--file-tree-indent-step);
  font-family: var(--font-ui);
}

.tree-list {
  list-style: none;
  margin: 0;
  padding: var(--space-1);
}

.tree-node {
  overflow: hidden;
  interpolate-size: allow-keywords;
}

.tree-collapse-enter-active,
.tree-collapse-leave-active {
  transition:
    block-size var(--duration-base) var(--ease-out),
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}

.tree-collapse-enter-from,
.tree-collapse-leave-to {
  block-size: 0;
  opacity: 0;
  transform: translateY(-3px);
}

.tree-collapse-enter-to,
.tree-collapse-leave-from {
  block-size: auto;
  opacity: 1;
  transform: translateY(0);
}

.tree-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  width: 100%;
  height: var(--file-tree-row-h);
  padding: var(--space-1) var(--space-1) var(--space-1) 0;
  border: none;
  border-radius: var(--file-tree-row-radius);
  background: none;
  text-align: left;
  font-family: inherit;
  font-size: var(--text-base);
  color: var(--color-text);
  cursor: pointer;
}

.tree-row::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(var(--tree-base-indent) + var(--space-1-5));
  width: calc(var(--tree-depth, 0) * var(--tree-indent-step));
  background: repeating-linear-gradient(
    to right,
    var(--color-line) 0 1px,
    transparent 1px var(--tree-indent-step)
  );
  pointer-events: none;
}

.tree-row:hover {
  background: var(--color-hover);
}

.tree-row.is-selected,
.tree-row.is-selected:hover {
  background: var(--color-selected);
}

.tree-row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.tree-lead {
  flex: none;
  color: var(--color-text-faint);
}

.tree-spinner {
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
}

.tree-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-symlink {
  flex: none;
  color: var(--color-text-faint);
}

.tree-more {
  margin-left: auto;
  opacity: 0;
}

.tree-row:hover .tree-more,
.tree-row:focus-within .tree-more {
  opacity: 1;
}

.tree-row.is-empty {
  color: var(--color-text-faint);
  cursor: default;
}

.tree-row.is-error {
  gap: var(--space-2);
  color: var(--color-danger);
  font-size: var(--text-xs);
  cursor: default;
}

.tree-row.is-error:hover {
  background: none;
}

.tree-error-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

</style>
