<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  FS_ALREADY_EXISTS_CODE,
  FS_PATH_NOT_FOUND_CODE,
  FS_PERMISSION_DENIED_CODE,
  FS_VALIDATION_FAILED_CODE,
  isDaemonApiError,
  type FsBrowseEntry,
  type FsBrowseResult,
} from '@moonshot-ai/app-core/api';
import { basename, isWindowsPath, isWorkspacePathInput, parseWorkspacePathInput } from '@moonshot-ai/app-core/lib';
import { Banner, Button, Checkbox, Dialog, Icon, IconButton, Input, Spinner, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';
import { hostsStore } from '@moonshot-ai/app-client/stores';

const { t } = useI18n();

const props = defineProps<{
  browseFs: (path: string | undefined, signal: AbortSignal) => Promise<FsBrowseResult>;
  searchFs: (root: string, query: string, signal: AbortSignal) => Promise<{ path: string; label: string }[]>;
  getFsHome: () => Promise<{ home: string; recentRoots: string[] }>;
  mkdirFs?: (path: string) => Promise<{ path: string }>;
  defaultPath?: string;
  hostId?: string;
  error?: string | null;
  multiple?: boolean;
}>();

const emit = defineEmits<{
  add: [root: string];
  addMany: [paths: string[]];
  close: [];
}>();

const open = ref(true);
const rootEl = ref<HTMLElement | null>(null);
const pathField = ref<InstanceType<typeof Input>>();
const loading = ref(false);
const browseFailed = ref(false);
const browseError = ref('');
const currentPath = ref('');
const parentPath = ref<string | null>(null);
const entries = ref<FsBrowseEntry[]>([]);
const searching = ref(false);
const searchFailed = ref(false);
interface SearchHit { path: string; name: string; rel: string }
const searchResults = ref<SearchHit[]>([]);
const isRemote = computed(() => props.hostId !== undefined);
const hostName = computed(() => props.hostId === undefined ? '' : hostsStore().displayName(props.hostId) ?? '');
const showBrowser = computed(() => !browseFailed.value);
let navigationToken = 0;
let navigationController: AbortController | undefined;
let searchToken = 0;
let searchController: AbortController | undefined;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let unmounted = false;

const createOpen = ref(false);
const newFolderName = ref('');
const createError = ref('');
const creatingFolder = ref(false);
const newFolderInputRef = ref<InstanceType<typeof Input> | null>(null);
const {
  handleCompositionStart: handleCreateCompositionStart,
  handleCompositionEnd: handleCreateCompositionEnd,
  resetComposition: resetCreateComposition,
  isComposingKeyEvent: isCreateComposingKeyEvent,
} = useImeComposition();

async function runSearch(query: string): Promise<void> {
  const root = currentPath.value;
  const q = query.trim();
  if (!root || q === '') return;
  const token = ++searchToken;
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  searching.value = true;
  searchFailed.value = false;
  try {
    const hits = await props.searchFs(root, q, controller.signal);
    if (token !== searchToken) return;
    searchResults.value = hits.map((hit) => ({
      path: hit.path,
      name: basename(hit.path),
      rel: hit.label,
    }));
  } catch {
    if (token === searchToken) searchFailed.value = true;
  } finally {
    if (searchController === controller) searchController = undefined;
    if (token === searchToken) searching.value = false;
  }
}

const pathInput = ref('');
const pathEditing = ref(false);
const activePathIndex = ref(-1);
const pathListId = useId();
let pathTimer: ReturnType<typeof setTimeout> | null = null;
const pathTrimmed = computed(() => pathInput.value.trim());
const pathValid = computed(() => isWorkspacePathInput(pathTrimmed.value));
const isSearching = computed(() => pathEditing.value && !pathValid.value && pathTrimmed.value.length > 0 && currentPath.value.length > 0);
const pathTarget = computed(() => {
  if (!pathValid.value) return null;
  const parsed = parseWorkspacePathInput(pathTrimmed.value, currentPath.value);
  const currentDirectory = pathTrimmed.value.endsWith(parsed.separator);
  return {
    directory: currentDirectory ? parsed.target : parsed.parent,
    prefix: currentDirectory ? '' : parsed.base,
  };
});
interface FolderOption extends FsBrowseEntry { label: string }
const visibleEntries = computed<FolderOption[]>(() => {
  if (isSearching.value) {
    return searchResults.value.map((hit) => ({ path: hit.path, name: hit.name, label: hit.rel, isDir: true }));
  }
  const target = pathTarget.value;
  const prefix = pathEditing.value && target !== null ? target.prefix.toLocaleLowerCase() : '';
  return entries.value
    .filter((entry) => {
      if (!entry.isDir || pathEditing.value && target === null) return false;
      return !pathEditing.value || entry.name.toLocaleLowerCase().startsWith(prefix);
    })
    .map((entry) => ({ ...entry, label: entry.name }));
});
const activePathOptionId = computed(() => pathEditing.value && activePathIndex.value >= 0
  ? `${pathListId}-${activePathIndex.value}`
  : undefined);

watch(visibleEntries, () => {
  activePathIndex.value = -1;
});

const canOpen = computed(() => currentPath.value.length > 0 && !loading.value && !creatingFolder.value && (!pathEditing.value || isSearching.value) && showBrowser.value);

function clearPathTimer(): void {
  if (pathTimer) clearTimeout(pathTimer);
  pathTimer = null;
}

function resetSearch(): void {
  searchToken++;
  searchController?.abort();
  searchController = undefined;
  if (searchTimer) clearTimeout(searchTimer);
  searching.value = false;
  searchFailed.value = false;
  searchResults.value = [];
}

async function navigate(path: string | undefined, keepPathDraft = false, preserveOnFailure = false): Promise<boolean> {
  const token = ++navigationToken;
  navigationController?.abort();
  const controller = new AbortController();
  navigationController = controller;
  clearPathTimer();
  resetSearch();
  if (!keepPathDraft) {
    pathEditing.value = false;
    activePathIndex.value = -1;
  }
  loading.value = true;
  browseFailed.value = false;
  browseError.value = '';
  try {
    const result = await props.browseFs(path, controller.signal);
    if (token !== navigationToken) return false;
    if (!result.path) {
      if (!preserveOnFailure) browseFailed.value = true;
      return false;
    }
    currentPath.value = result.path;
    parentPath.value = result.parent;
    entries.value = result.entries;
    if (!keepPathDraft) pathInput.value = result.path;
    resetCreateFolder();
    return true;
  } catch (error) {
    if (token !== navigationToken || preserveOnFailure) return false;
    currentPath.value = '';
    parentPath.value = null;
    entries.value = [];
    browseFailed.value = true;
    browseError.value = isRemote.value && error instanceof Error ? error.message : '';
    return false;
  } finally {
    if (navigationController === controller) navigationController = undefined;
    if (token === navigationToken) loading.value = false;
  }
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function isValidFolderName(name: string, parent: string): boolean {
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return false;
  const win = isWindowsPath(parent);
  for (const ch of name) {
    const cp = ch.codePointAt(0);
    if (cp === 0 || (win && cp !== undefined && cp < 32)) return false;
  }
  if (win && (/[<>:"|?*]/.test(name) || name.endsWith('.') || WINDOWS_RESERVED_NAME.test(name))) {
    return false;
  }
  return true;
}

function joinChildFolderPath(parent: string, name: string): string {
  if (isWindowsPath(parent)) {
    const sep = parent.includes('\\') || !parent.includes('/') ? '\\' : '/';
    return parent.endsWith('\\') || parent.endsWith('/') ? `${parent}${name}` : `${parent}${sep}${name}`;
  }
  return parent === '/' ? `/${name}` : `${parent.replace(/\/+$/, '')}/${name}`;
}

function mkdirErrorMessage(err: unknown): string {
  if (isDaemonApiError(err)) {
    if (err.code === FS_ALREADY_EXISTS_CODE) return t('workspace.newFolderExists');
    if (err.code === FS_PERMISSION_DENIED_CODE) return t('workspace.newFolderPermissionDenied');
    if (err.code === FS_PATH_NOT_FOUND_CODE) return t('workspace.newFolderParentNotFound');
    if (err.code === FS_VALIDATION_FAILED_CODE) return t('workspace.newFolderInvalid');
  }
  return t('workspace.newFolderFailed');
}

function resetCreateFolder(): void {
  createOpen.value = false;
  newFolderName.value = '';
  createError.value = '';
  resetCreateComposition();
}

function toggleCreateFolder(): void {
  if (loading.value || creatingFolder.value || !currentPath.value || !props.mkdirFs) return;
  if (createOpen.value) {
    cancelCreateFolder();
    return;
  }
  createOpen.value = true;
  newFolderName.value = '';
  createError.value = '';
  void nextTick(() => {
    newFolderInputRef.value?.focus();
  });
}

function cancelCreateFolder(): void {
  if (creatingFolder.value) return;
  resetCreateFolder();
  void nextTick(() => {
    rootEl.value?.querySelector<HTMLButtonElement>('.new-folder-trigger')?.focus();
  });
}

function onNewFolderInput(value: string): void {
  newFolderName.value = value;
  if (createError.value) createError.value = '';
}

async function submitCreateFolder(): Promise<void> {
  if (creatingFolder.value || loading.value || !currentPath.value || !props.mkdirFs) return;
  const trimmed = newFolderName.value.trim();
  if (trimmed.length === 0) {
    createError.value = t('workspace.newFolderEmpty');
    void nextTick(() => newFolderInputRef.value?.focus());
    return;
  }
  if (!isValidFolderName(trimmed, currentPath.value)) {
    createError.value = t('workspace.newFolderInvalid');
    void nextTick(() => {
      newFolderInputRef.value?.focus();
      newFolderInputRef.value?.select();
    });
    return;
  }
  const parentDir = currentPath.value;
  const targetPath = joinChildFolderPath(parentDir, trimmed);
  creatingFolder.value = true;
  createError.value = '';
  try {
    const created = await props.mkdirFs(targetPath);
    if (unmounted) return;
    const dest = created.path || targetPath;
    const entered = await navigate(dest, false, true);
    if (!entered && !unmounted) {
      resetCreateFolder();
      await navigate(parentDir);
    }
  } catch (err) {
    if (unmounted) return;
    createError.value = mkdirErrorMessage(err);
    void nextTick(() => {
      newFolderInputRef.value?.focus();
      newFolderInputRef.value?.select();
    });
  } finally {
    if (!unmounted) creatingFolder.value = false;
  }
}

function onCreateEnter(e: KeyboardEvent): void {
  if (isCreateComposingKeyEvent(e)) return;
  void submitCreateFolder();
}

function onCreateKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && isCreateComposingKeyEvent(e)) {
    e.stopPropagation();
  }
}

function onCreateBarKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  e.preventDefault();
  cancelCreateFolder();
}

function onPathFocus(event: FocusEvent): void {
  if (!pathEditing.value) (event.target as HTMLInputElement).select();
}

function onPathInput(value: string): void {
  pathInput.value = value;
  pathEditing.value = true;
  activePathIndex.value = -1;
  clearPathTimer();
  resetSearch();
  const target = pathTarget.value;
  if (target === null) {
    navigationToken++;
    navigationController?.abort();
    navigationController = undefined;
    loading.value = false;
    if (isSearching.value) {
      const query = pathTrimmed.value;
      searchTimer = setTimeout(() => void runSearch(query), 220);
    }
    return;
  }
  pathTimer = setTimeout(() => void navigate(target.directory, true), 160);
}

function openEntry(entry: FsBrowseEntry): void {
  if (!entry.isDir || creatingFolder.value) return;
  void navigate(entry.path);
}

function goUp(): void {
  if (parentPath.value && !creatingFolder.value) void navigate(parentPath.value);
}

function openThisFolder(): void {
  if (!canOpen.value) return;
  if (props.multiple) {
    toggleSelect(currentPath.value);
    return;
  }
  emit('add', currentPath.value);
}

const selected = ref<string[]>([]);
const pathsToAdd = computed(() => {
  if (!props.multiple || !pathEditing.value || !pathValid.value || selected.value.includes(pathTrimmed.value)) return selected.value;
  return [...selected.value, pathTrimmed.value];
});

function toggleSelect(path: string): void {
  selected.value = selected.value.includes(path)
    ? selected.value.filter((p) => p !== path)
    : [...selected.value, path];
}

function isSelected(path: string): boolean {
  return selected.value.includes(path);
}

function addSelected(): void {
  if (pathsToAdd.value.length === 0 || creatingFolder.value) return;
  emit('addMany', [...pathsToAdd.value]);
}

function handlePathAdd(): void {
  if (!pathValid.value || creatingFolder.value) return;
  clearPathTimer();
  pathEditing.value = false;
  activePathIndex.value = -1;
  if (props.multiple) {
    if (!selected.value.includes(pathTrimmed.value)) {
      selected.value = [...selected.value, pathTrimmed.value];
    }
    pathInput.value = currentPath.value;
    return;
  }
  emit('add', pathTrimmed.value);
}

const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();
function onPathEnter(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e) || creatingFolder.value) return;
  const active = visibleEntries.value[activePathIndex.value];
  if (pathEditing.value && active !== undefined) {
    if (!loading.value) openEntry(active);
    return;
  }
  if (pathValid.value) handlePathAdd();
}
function onPathKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && isComposingKeyEvent(e)) e.stopPropagation();
  if (isComposingKeyEvent(e) || !pathEditing.value || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  const count = visibleEntries.value.length;
  if (count === 0) return;
  e.preventDefault();
  const offset = e.key === 'ArrowDown' ? 1 : -1;
  activePathIndex.value = activePathIndex.value < 0
    ? offset > 0 ? 0 : count - 1
    : (activePathIndex.value + offset + count) % count;
  void nextTick(() => {
    document.getElementById(`${pathListId}-${activePathIndex.value}`)?.scrollIntoView?.({ block: 'nearest' });
  });
}

async function loadInitial(): Promise<void> {
  navigationToken++;
  clearPathTimer();
  loading.value = true;
  browseFailed.value = false;
  pathEditing.value = false;
  activePathIndex.value = -1;
  const initialPath = props.defaultPath?.trim() ?? '';
  pathInput.value = initialPath;
  if (initialPath) {
    await navigate(initialPath);
    return;
  }
  if (isRemote.value) {
    await navigate(undefined);
    return;
  }
  try {
    const home = await props.getFsHome();
    if (home.home) await navigate(home.home);
    else browseFailed.value = true;
  } catch {
    browseFailed.value = true;
  } finally {
    loading.value = false;
  }
}

onMounted(loadInitial);

onUnmounted(() => {
  unmounted = true;
  navigationToken++;
  searchToken++;
  navigationController?.abort();
  searchController?.abort();
  clearPathTimer();
  if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
  <Dialog
    v-model:open="open"
    :title="isRemote ? (hostName ? t('workspace.remotePickerTitleWithHost', { device: hostName }) : t('workspace.remotePickerTitle')) : t('workspace.addTitle')"
    size="lg"
    :padded="false"
    :initial-focus="() => pathField?.el ?? null"
    :close-on-esc="!creatingFolder"
    :close-on-overlay="!creatingFolder"
    :hide-close="creatingFolder"
    @close="emit('close')"
  >
    <div ref="rootEl" class="aw">
      <div class="pathbar">
        <IconButton
          size="sm"
          :disabled="loading || creatingFolder || !parentPath"
          :label="t('workspace.up')"
          :tooltip="t('workspace.up')"
          @click="goUp"
        >
          <Icon name="arrow-up" size="md" />
        </IconButton>
        <div class="path-input-wrap">
          <Input
            ref="pathField"
            :model-value="pathEditing || currentPath === '' ? pathInput : currentPath"
            size="sm"
            :placeholder="t('workspace.pathPlaceholder')"
            :aria-label="t('workspace.pathLabel')"
            :disabled="creatingFolder"
            role="combobox"
            aria-autocomplete="list"
            :aria-controls="showBrowser ? pathListId : undefined"
            :aria-expanded="pathEditing && showBrowser"
            :aria-activedescendant="activePathOptionId"
            autocomplete="off"
            spellcheck="false"
            @update:model-value="onPathInput"
            @focus="onPathFocus"
            @keydown.enter.stop="onPathEnter"
            @keydown="onPathKeydown"
            @compositionstart="handleCompositionStart"
            @compositionend="handleCompositionEnd"
          />
        </div>
        <Spinner v-if="searching" size="sm" />
        <IconButton
          v-if="pathEditing && pathValid"
          class="path-add"
          :disabled="creatingFolder"
          :label="t('workspace.add')"
          :tooltip="t('workspace.add')"
          @click="handlePathAdd"
        >
          <Icon name="plus" size="md" />
        </IconButton>
        <Button
          v-if="mkdirFs"
          class="new-folder-trigger"
          variant="ghost"
          size="xs"
          :aria-expanded="createOpen"
          :disabled="loading || !currentPath || creatingFolder"
          @click="toggleCreateFolder"
        >
          <Icon name="folder-plus" size="sm" />
          <span>{{ t('workspace.newFolder') }}</span>
        </Button>
      </div>

      <div v-if="createOpen && !loading" class="createbar" @keydown="onCreateBarKeydown">
        <div class="create-row">
          <Icon class="create-icon" name="folder-plus" size="sm" />
          <div class="create-input-wrap">
            <Input
              ref="newFolderInputRef"
              :model-value="newFolderName"
              size="sm"
              :placeholder="t('workspace.newFolderPlaceholder')"
              :disabled="creatingFolder"
              :error="createError.length > 0"
              :aria-label="t('workspace.newFolderPlaceholder')"
              :aria-invalid="createError.length > 0 || undefined"
              autocomplete="off"
              spellcheck="false"
              @update:model-value="onNewFolderInput"
              @keydown.enter.stop.prevent="onCreateEnter"
              @keydown="onCreateKeydown"
              @compositionstart="handleCreateCompositionStart"
              @compositionend="handleCreateCompositionEnd"
            />
          </div>
          <Button
            class="new-folder-submit"
            variant="primary"
            size="sm"
            :loading="creatingFolder"
            @click="submitCreateFolder"
          >{{ t('workspace.newFolderSubmit') }}</Button>
          <Button
            class="new-folder-cancel"
            variant="ghost"
            size="sm"
            :disabled="creatingFolder"
            @click="cancelCreateFolder"
          >{{ t('workspace.cancel') }}</Button>
        </div>
        <div v-if="createError" class="create-error" role="alert">{{ createError }}</div>
      </div>
      <div v-if="isSearching" class="path-hint" :title="currentPath">{{ t('workspace.searchingIn', { path: currentPath }) }}</div>

      <template v-if="showBrowser">
        <div :id="pathListId" class="folder-list" :role="pathEditing ? 'listbox' : undefined">
          <div v-if="loading" class="fl-loading" role="status">
            <Spinner size="sm" />{{ isRemote ? t('workspace.remoteBrowsing', { device: hostName }) : t('workspace.browsing') }}
          </div>
          <template v-else>
            <Banner v-if="searchFailed" class="search-error" variant="danger" role="alert">
              <span class="banner-row">
                <span>{{ t('workspace.searchFailed') }}</span>
                <Button variant="secondary" size="xs" @click="runSearch(pathTrimmed)">{{ t('fileTree.retry') }}</Button>
              </span>
            </Banner>
            <div
              v-for="(entry, i) in visibleEntries"
              :key="entry.path"
              class="folder-row"
              :class="{ 'folder-row--multi': multiple, 'folder-row--active': pathEditing && activePathIndex === i }"
            >
              <Checkbox
                v-if="multiple"
                :model-value="isSelected(entry.path)"
                :disabled="creatingFolder"
                :aria-label="entry.label"
                @update:model-value="toggleSelect(entry.path)"
                @click.stop
              />
              <button
                :id="`${pathListId}-${i}`"
                class="folder-open"
                :disabled="loading || creatingFolder"
                :role="pathEditing ? 'option' : undefined"
                :aria-selected="pathEditing ? activePathIndex === i : undefined"
                @click="openEntry(entry)"
              >
                <Icon class="dir-icon" name="folder-closed" size="sm" />
                <span class="folder-name" :class="{ 'search-rel': isSearching }">{{ entry.label }}</span>
              </button>
            </div>
            <div v-if="searching && visibleEntries.length === 0" class="fl-loading">{{ t('workspace.searching') }}</div>
            <div v-else-if="!searchFailed && visibleEntries.length === 0" class="fl-empty">
              <template v-if="isSearching">{{ t('workspace.noFilterMatch', { q: pathTrimmed }) }}</template>
              <template v-else-if="pathEditing && !pathValid">{{ t('workspace.pathPlaceholder') }}</template>
              <template v-else-if="pathEditing && pathTarget?.prefix">{{ t('workspace.noFilterMatch', { q: pathTarget.prefix }) }}</template>
              <template v-else>{{ t('workspace.noSubfolders') }}</template>
            </div>
          </template>
        </div>
      </template>

      <Banner v-if="browseFailed" class="browse-error" variant="danger" role="alert">
        <span class="banner-row">
          <span class="browse-error-copy">
            <span>{{ isRemote ? t('workspace.remoteBrowseFailed') : t('workspace.addFailed') }}</span>
            <span v-if="browseError" class="browse-error-detail">{{ browseError }}</span>
          </span>
          <Button variant="secondary" size="xs" @click="loadInitial">{{ t('fileTree.retry') }}</Button>
        </span>
      </Banner>

      <Banner v-if="error" class="add-error" variant="danger" role="alert">{{ error }}</Banner>

      <div class="actions">
        <Button variant="ghost" :disabled="creatingFolder" @click="emit('close')">{{ t('workspace.cancel') }}</Button>
        <Tooltip v-if="showBrowser" :text="currentPath">
          <Button
            :variant="multiple ? 'secondary' : 'primary'"
            :disabled="!canOpen"
            @click="openThisFolder"
          >{{ multiple ? t('workspace.selectThisFolder') : t('workspace.openThisFolder') }}</Button>
        </Tooltip>
        <Button
          v-if="multiple"
          variant="primary"
          :disabled="pathsToAdd.length === 0 || creatingFolder"
          @click="addSelected"
        >{{ t('workspace.addSelected', { n: pathsToAdd.length }) }}</Button>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.browse-error,
.add-error {
  margin: var(--space-3) var(--dialog-pad-x);
}
.banner-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-width: 0;
}
.browse-error-copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}
.browse-error-detail {
  max-height: 120px;
  overflow-y: auto;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  white-space: pre-line;
  overflow-wrap: anywhere;
  user-select: text;
}

.pathbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 54px;
  padding: var(--space-2) var(--dialog-pad-x);
  border-bottom: var(--p-hairline) solid var(--color-line);
}
.path-input-wrap {
  flex: 1;
  min-width: 0;
}
.path-input-wrap :deep(.ui-input) {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
.path-add { flex: none; }
.new-folder-trigger { flex: none; }

.createbar {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--dialog-pad-x);
  background: var(--color-surface-sunken);
  border-bottom: var(--p-hairline) solid var(--color-line);
}
.create-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.create-icon {
  flex: none;
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
  color: var(--color-text-muted);
}
.create-input-wrap { flex: 1; min-width: 0; }
.create-error {
  padding-left: calc(var(--p-ic-sm) + var(--space-2));
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-danger);
}

.path-hint {
  padding: var(--space-2) var(--dialog-pad-x);
  border-bottom: var(--p-hairline) solid var(--color-line);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.search-rel { color: var(--color-text); }

.folder-list {
  height: min(300px, 42vh);
  min-height: 160px;
  overflow-y: auto;
  padding: var(--space-1) var(--space-2);
}
.fl-loading, .fl-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-4);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.search-error {
  margin: var(--space-1);
}
.folder-row {
  display: flex;
  align-items: center;
  border-radius: var(--radius-md);
  transition: background var(--duration-fast) var(--ease-out);
}
.folder-row:hover,
.folder-row--active { background: var(--color-hover); }
.folder-row--multi { padding-left: var(--space-3); }
.folder-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  color: var(--color-text);
  text-align: left;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
}
.folder-open:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.folder-row--multi .folder-open { padding-left: var(--space-1); }
.dir-icon { flex: none; width: var(--p-ic-sm); height: var(--p-ic-sm); color: var(--color-text-muted); }
.folder-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--dialog-pad-x);
  border-top: var(--p-hairline) solid var(--color-line);
}

@media (max-width: 640px) {
  .folder-row { min-height: 44px; }
  .actions { flex-wrap: wrap; }
  .banner-row { align-items: flex-start; }
}
</style>
