<!-- apps/kimi-web/src/components/dialogs/AddWorkspaceDialog.vue -->
<!-- Daemon-driven folder browser for adding a workspace: starts at $HOME -->
<!-- (fs:home), shows recent roots as quick-picks, a clickable breadcrumb, and -->
<!-- the folder list (fs:browse). "Open this folder" adds the current path. -->
<!-- Falls back to a paste-path escape hatch when the daemon can't browse. -->
<!-- Built on the design-system Dialog / Field / Input / Button primitives. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FsBrowseEntry, FsBrowseResult } from '../../api/types';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import IconButton from '../ui/IconButton.vue';
import Input from '../ui/Input.vue';
import Field from '../ui/Field.vue';
import Spinner from '../ui/Spinner.vue';
import Badge from '../ui/Badge.vue';
import Icon from '../ui/Icon.vue';
import Tooltip from '../ui/Tooltip.vue';

const { t } = useI18n();

const props = defineProps<{
  browseFs: (path?: string) => Promise<FsBrowseResult>;
  getFsHome: () => Promise<{ home: string; recentRoots: string[] }>;
  /** Where the browser opens by default — the path kimi-web is working in. */
  defaultPath?: string;
  /** Inline error from a failed add attempt (e.g. daemon rejected the path). */
  error?: string | null;
}>();

const emit = defineEmits<{
  add: [root: string];
  close: [];
}>();

// The parent controls visibility with `v-if`, so the dialog is open whenever
// this component is mounted. Dialog owns focus, Esc-to-close, overlay-click,
// and the close button; we forward its `close` event to the parent.
const open = ref(true);

// ---------------------------------------------------------------------------
// Browser state
// ---------------------------------------------------------------------------
const loading = ref(false);
const browseFailed = ref(false);
const currentPath = ref('');
const parentPath = ref<string | null>(null);
const entries = ref<FsBrowseEntry[]>([]);

// fzf-style search: typing runs a bounded RECURSIVE fuzzy search under the
// current folder (not just a one-level filter), so a deep target is reachable
// without clicking down the tree. The result list keeps a fixed height, so the
// dialog never resizes while searching.
const filter = ref('');
const searching = ref(false);
interface SearchHit { path: string; name: string; rel: string; isGitRepo?: boolean; branch?: string }
const searchResults = ref<SearchHit[]>([]);
const isSearching = computed(() => filter.value.trim().length > 0);
let searchToken = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

/** Subsequence fuzzy match (query chars appear in order). */
function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  let qi = 0;
  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] === q[qi]) qi++;
  }
  return qi === q.length;
}

const SEARCH_MAX_DIRS = 600;
const SEARCH_MAX_DEPTH = 6;
const SEARCH_MAX_RESULTS = 150;

async function runSearch(query: string): Promise<void> {
  const root = currentPath.value;
  const q = query.trim();
  if (!root || q === '') {
    searchResults.value = [];
    searching.value = false;
    return;
  }
  const token = ++searchToken;
  searching.value = true;
  const hits: SearchHit[] = [];
  const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < SEARCH_MAX_DIRS && hits.length < SEARCH_MAX_RESULTS) {
    if (token !== searchToken) return; // superseded by a newer query
    const node = queue.shift()!;
    visited++;
    let res: FsBrowseResult;
    try {
      res = await props.browseFs(node.path);
    } catch {
      continue;
    }
    if (token !== searchToken) return;
    for (const e of res.entries) {
      if (!e.isDir) continue;
      const rel = e.path.startsWith(root) ? e.path.slice(root.length).replace(/^\/+/, '') : e.path;
      if (fuzzyMatch(q, rel || e.name)) {
        hits.push({ path: e.path, name: e.name, rel: rel || e.name, isGitRepo: e.isGitRepo, branch: e.branch });
        if (hits.length >= SEARCH_MAX_RESULTS) break;
      }
      if (node.depth + 1 < SEARCH_MAX_DEPTH) queue.push({ path: e.path, depth: node.depth + 1 });
    }
    if (token === searchToken) searchResults.value = [...hits]; // incremental
  }
  if (token === searchToken) searching.value = false;
}

watch(filter, (q) => {
  if (searchTimer) clearTimeout(searchTimer);
  if (q.trim() === '') {
    searchToken++; // cancel any in-flight walk
    searchResults.value = [];
    searching.value = false;
    return;
  }
  searchTimer = setTimeout(() => void runSearch(q), 220);
});

// Paste-path escape hatch — collapsed into a secondary "enter path" affordance.
const pasteOpen = ref(false);
const pathInput = ref('');
const pathTrimmed = computed(() => pathInput.value.trim());

/** Split the current absolute path into clickable breadcrumb segments. */
const crumbs = computed<{ label: string; path: string }[]>(() => {
  const p = currentPath.value;
  if (!p) return [];
  const parts = p.split('/').filter(Boolean);
  const out: { label: string; path: string }[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
});

const canOpen = computed(() => currentPath.value.length > 0);

async function navigate(path?: string): Promise<void> {
  loading.value = true;
  try {
    const result = await props.browseFs(path);
    // A result with no path back means the daemon can't browse → fall back to
    // the paste field (the adapter returns { path: '', parent: null, [] } on error).
    if (!result.path) {
      browseFailed.value = true;
      return;
    }
    currentPath.value = result.path;
    parentPath.value = result.parent;
    entries.value = result.entries;
    filter.value = ''; // a fresh folder starts unfiltered
    browseFailed.value = false;
  } catch {
    browseFailed.value = true;
  } finally {
    loading.value = false;
  }
}

function openEntry(entry: FsBrowseEntry): void {
  if (!entry.isDir) return;
  void navigate(entry.path);
}

function goUp(): void {
  if (parentPath.value) void navigate(parentPath.value);
}

function openThisFolder(): void {
  if (!canOpen.value) return;
  emit('add', currentPath.value);
}

function handlePasteAdd(): void {
  if (pathTrimmed.value.length === 0) return;
  emit('add', pathTrimmed.value);
}

onMounted(async () => {
  loading.value = true;
  try {
    // Default to the path kimi-web is working in; fall back to $HOME.
    if (props.defaultPath) {
      await navigate(props.defaultPath);
      if (!browseFailed.value) return;
    }
    const home = await props.getFsHome();
    if (home.home) {
      await navigate(home.home);
    } else {
      browseFailed.value = true;
    }
  } catch {
    browseFailed.value = true;
  } finally {
    loading.value = false;
  }
});

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
  <Dialog v-model:open="open" :title="t('workspace.addTitle')" size="lg" height="fixed" @close="emit('close')">
    <div class="aw">
      <!-- Folder browser -->
      <template v-if="!browseFailed">
        <!-- Breadcrumb + up -->
        <div class="crumbbar">
          <IconButton
            size="sm"
            :disabled="!parentPath"
            :label="t('workspace.up')"
            @click="goUp"
          >
            <Icon name="arrow-up" size="md" />
          </IconButton>
          <div class="crumbs">
            <template v-for="(c, i) in crumbs" :key="c.path">
              <!-- crumbs[0] is the root "/" itself, so skip the separator before crumbs[1]. -->
              <span v-if="i > 1" class="crumb-sep">/</span>
              <button class="crumb" :class="{ last: i === crumbs.length - 1 }" @click="navigate(c.path)">{{ c.label }}</button>
            </template>
          </div>
        </div>

        <!-- fzf search across the whole current folder (recursive, fuzzy) -->
        <div v-if="!loading" class="filterbar">
          <Icon class="filter-icon" name="search" size="md" />
          <input
            v-model="filter"
            class="filter-input"
            type="text"
            :placeholder="t('workspace.searchPlaceholder')"
            autocomplete="off"
            spellcheck="false"
            @keydown.stop
          />
          <Spinner v-if="searching" size="sm" />
        </div>

        <!-- Folder list. Fixed height → the dialog never resizes while searching. -->
        <div class="folder-list">
          <div v-if="loading" class="fl-loading">{{ t('workspace.browsing') }}</div>

          <!-- Search mode: recursive fuzzy hits (relative paths) -->
          <template v-else-if="isSearching">
            <button
              v-for="hit in searchResults"
              :key="hit.path"
              class="folder-row"
              @click="navigate(hit.path)"
            >
              <Icon class="dir-icon" name="folder-closed" size="sm" />
              <span class="folder-name search-rel">{{ hit.rel }}</span>
              <Badge v-if="hit.isGitRepo" variant="info" size="sm">
                {{ t('workspace.gitTag') }}<span v-if="hit.branch" class="git-branch"> {{ hit.branch }}</span>
              </Badge>
            </button>
            <div v-if="!searching && searchResults.length === 0" class="fl-empty">{{ t('workspace.noFilterMatch', { q: filter.trim() }) }}</div>
            <div v-else-if="searching && searchResults.length === 0" class="fl-loading">{{ t('workspace.searching') }}</div>
          </template>

          <!-- Browse mode: the current folder's subfolders -->
          <template v-else>
            <button
              v-for="entry in entries"
              :key="entry.path"
              class="folder-row"
              @click="openEntry(entry)"
            >
              <Icon class="dir-icon" name="folder-closed" size="sm" />
              <span class="folder-name">{{ entry.name }}</span>
              <Badge v-if="entry.isGitRepo" variant="info" size="sm">
                {{ t('workspace.gitTag') }}<span v-if="entry.branch" class="git-branch"> {{ entry.branch }}</span>
              </Badge>
            </button>
            <div v-if="entries.length === 0" class="fl-empty">{{ t('workspace.noSubfolders') }}</div>
          </template>
        </div>
      </template>

      <!-- Paste an absolute path — secondary, collapsed behind a toggle (always
           expanded when the daemon can't browse, since it's then the only way). -->
      <div class="paste-section" :class="{ 'paste-only': browseFailed }">
        <Button
          v-if="!browseFailed && !pasteOpen"
          variant="ghost"
          size="sm"
          @click="pasteOpen = true"
        >
          {{ t('workspace.pasteToggle') }}
        </Button>
        <Field v-else :label="t('workspace.pathLabel')">
          <div class="paste-row">
            <div class="paste-input-wrap">
              <Input
                v-model="pathInput"
                :placeholder="t('workspace.pathPlaceholder')"
                autocomplete="off"
                spellcheck="false"
                @keydown.enter.stop="handlePasteAdd"
              />
            </div>
            <IconButton
              :disabled="pathTrimmed.length === 0"
              :label="t('workspace.add')"
              @click="handlePasteAdd"
            >
              <Icon name="plus" size="md" />
            </IconButton>
          </div>
        </Field>
      </div>

      <!-- Inline error from a failed add attempt. Shown inside the dialog so it
           is visible above the backdrop and persists until the next attempt. -->
      <div v-if="error" class="add-error" role="alert">{{ error }}</div>

      <!-- Actions -->
      <div class="actions">
        <Tooltip :text="currentPath">
          <Button
            v-if="!browseFailed"
            variant="primary"
            :disabled="!canOpen"
            @click="openThisFolder"
          >{{ t('workspace.openThisFolder') }}</Button>
        </Tooltip>
        <Button variant="secondary" @click="emit('close')">{{ t('workspace.cancel') }}</Button>
      </div>

      <div class="footer-hint">{{ t('workspace.browseHint') }}</div>
    </div>
  </Dialog>
</template>

<style scoped>
/* Pull the browser layout to the panel edges so the section separators span
   the full dialog width, matching the original full-bleed rows. */
.aw {
  margin-left: calc(-1 * var(--space-5));
  margin-right: calc(-1 * var(--space-5));
  margin-bottom: calc(-1 * var(--space-4));
}

/* Breadcrumb bar */
.crumbbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-5);
  border-bottom: 1px solid var(--color-line);
}
.crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 1px;
  min-width: 0;
  font-size: var(--text-sm);
}
.crumb-sep { color: var(--color-text-muted); }
.crumb {
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  padding: 1px var(--space-1);
  border-radius: var(--radius-xs);
}
.crumb:hover { color: var(--color-accent); background: var(--color-surface-sunken); }
.crumb.last { color: var(--color-text); font-weight: var(--weight-medium); }

/* Subfolder filter — composite inline search (icon + input + spinner). */
.filterbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-5);
  border-bottom: 1px solid var(--color-line);
}
.filter-icon { flex: none; width: var(--p-ic-sm); height: var(--p-ic-sm); color: var(--color-text-muted); }
.filter-input {
  flex: 1;
  min-width: 0;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  padding: var(--space-1) 0;
  border: none;
  background: none;
  color: var(--color-text);
  outline: none;
}
.filter-input::placeholder { color: var(--color-text-muted); }
.search-rel { color: var(--color-text); }

/* Folder list */
.folder-list {
  height: 300px;
  overflow-y: auto;
  padding: var(--space-1) var(--space-2);
}
.fl-loading, .fl-empty {
  padding: var(--space-6) var(--space-4);
  text-align: center;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.folder-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  color: var(--color-text);
  text-align: left;
  padding: var(--space-1) var(--space-4);
  border-radius: var(--radius-md);
}
.folder-row:hover { background: var(--color-surface-sunken); }
.dir-icon { flex: none; width: var(--p-ic-sm); height: var(--p-ic-sm); color: var(--color-text-muted); }
.folder-row:hover .dir-icon { color: var(--color-accent); }
.folder-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}
.git-branch { color: var(--color-text-muted); }

/* Paste-path escape hatch */
.paste-section {
  padding: var(--space-3) var(--space-5);
  border-top: 1px solid var(--color-line);
}
.paste-section.paste-only { border-top: none; }
.paste-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.paste-input-wrap { flex: 1; min-width: 0; }

/* Actions */
.add-error {
  margin: 0 14px 8px;
  padding: 6px 10px;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  color: #b3261e;
  background: rgba(179, 38, 30, 0.08);
  border: 1px solid rgba(179, 38, 30, 0.25);
  border-radius: 3px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
}

.footer-hint {
  padding: var(--space-2) var(--space-5);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  border-top: 1px solid var(--color-line);
}

@media (max-width: 640px) {
  .folder-row {
    min-height: 44px;
  }
  .crumbbar {
    align-items: flex-start;
  }
  .actions {
    flex-wrap: wrap;
  }
}
</style>
