<!-- apps/kimi-web/src/components/dialogs/AddWorkspaceDialog.vue -->
<!-- Daemon-driven folder browser for adding a workspace: starts at the path -->
<!-- kimi-web is working in, with a clickable breadcrumb and the folder list -->
<!-- (fs:browse). "Open this folder" adds the current path. The search box -->
<!-- doubles as an absolute-path entry: absolute-looking input (POSIX, "~", -->
<!-- Windows drive or UNC) is validated live and the browser follows valid -->
<!-- paths, so the existing "Open this folder" button submits them. When the -->
<!-- daemon can't browse, the same box is the only way to add a path. -->
<!-- Built on the design-system Dialog / Button / IconButton primitives. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FsBrowseEntry, FsBrowseResult } from '../../api/types';
import {
  currentValidatedWorkspacePath,
  isWorkspacePathInput,
  joinWorkspacePathCandidate,
  parseWorkspacePathInput,
  type WorkspacePathSeparator,
} from '../../lib/workspacePathInput';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import IconButton from '../ui/IconButton.vue';
import Spinner from '../ui/Spinner.vue';
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
interface SearchHit { path: string; name: string; rel: string }
const searchResults = ref<SearchHit[]>([]);
const isSearching = computed(() => filter.value.trim().length > 0);
let searchToken = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

// Absolute-path entry shares the same box: absolute-looking input switches
// from fuzzy search to path mode — POSIX ("/x"), home ("~" / "~/x"), Windows
// drive ("C:\x" / "C:/x") and UNC ("\\srv\x"). A valid path live-follows (the
// browser jumps to it, so "Open this folder" submits it); an invalid one
// shows a specific error plus prefix-matched candidates in the list.
const isPathMode = computed(() => isWorkspacePathInput(filter.value));
type PathState = 'idle' | 'checking' | 'valid' | 'not-found' | 'bad-parent';
const pathState = ref<PathState>('idle');
const pathParent = ref('');
const pathSeparator = ref<WorkspacePathSeparator>('/');
const pathCandidates = ref<FsBrowseEntry[]>([]);
/** $HOME for expanding "~" — fetched eagerly on mount. */
const homePath = ref('');
const filterEl = ref<HTMLInputElement | null>(null);
/** The lexical path the user typed, kept for the add action: the daemon's
 *  browse result is canonicalized (realpath), but workspace ids are based on
 *  the lexical root, so a typed symlink path must not be submitted as its
 *  resolved target. Null outside path mode or when the input isn't valid. */
const typedAddPath = ref<string | null>(null);
const validatedAddPath = computed(() => {
  if (pathState.value !== 'valid') return null;
  return currentValidatedWorkspacePath(filter.value, homePath.value, typedAddPath.value);
});
let pathToken = 0;
let pathTimer: ReturnType<typeof setTimeout> | null = null;

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
        hits.push({ path: e.path, name: e.name, rel: rel || e.name });
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
  if (pathTimer) clearTimeout(pathTimer);
  // Invalidate the previous path immediately, before the next debounced check.
  // This also makes any in-flight response stale and prevents Enter/Open from
  // submitting the last valid path while the input already shows a new one.
  pathToken++;
  pathState.value = 'idle';
  pathCandidates.value = [];
  typedAddPath.value = null;
  const t = q.trim();
  if (t === '') {
    searchToken++; // cancel any in-flight walk
    searchResults.value = [];
    searching.value = false;
    return;
  }
  if (isWorkspacePathInput(t)) {
    // Path mode — fuzzy search is off; validate unless browsing is down (then
    // the box is format-only and Enter adds directly).
    searchToken++;
    searchResults.value = [];
    searching.value = false;
    if (browseFailed.value) return;
    pathState.value = 'checking';
    pathTimer = setTimeout(() => void validatePathInput(t), 150);
    return;
  }
  searchTimer = setTimeout(() => void runSearch(q), 220);
});

/**
 * Debounced validation for path-mode input. `browseFs` defensively returns an
 * empty path on failure, so a miss means "doesn't exist"; we then browse the
 * parent for prefix-matched candidates. On a hit the browser live-follows.
 */
async function validatePathInput(raw: string): Promise<void> {
  const token = ++pathToken;
  pathState.value = 'checking';
  typedAddPath.value = null;
  const parsed = parseWorkspacePathInput(raw, homePath.value);
  const { target } = parsed;
  try {
    const res = await props.browseFs(target);
    if (token !== pathToken) return;
    if (res.path) {
      pathState.value = 'valid';
      pathCandidates.value = [];
      typedAddPath.value = target;
      // Display follows the canonical target; the add action uses typedAddPath.
      currentPath.value = res.path;
      parentPath.value = res.parent;
      entries.value = res.entries;
      browseFailed.value = false;
      return;
    }
  } catch {
    // fall through to the not-found handling below
  }
  if (token !== pathToken) return;
  const base = parsed.base.toLowerCase();
  pathParent.value = parsed.parent;
  pathSeparator.value = parsed.separator;
  try {
    const res = await props.browseFs(parsed.parent);
    if (token !== pathToken) return;
    if (res.path) {
      pathCandidates.value = res.entries.filter(
        (e) => e.isDir && e.name.toLowerCase().startsWith(base),
      );
      pathState.value = 'not-found';
      return;
    }
  } catch {
    // fall through to bad-parent
  }
  if (token !== pathToken) return;
  pathCandidates.value = [];
  pathState.value = 'bad-parent';
}

/** Accept a completion candidate while preserving the lexical parent path. */
function pickCandidate(name: string): void {
  filter.value = joinWorkspacePathCandidate(pathParent.value, name, pathSeparator.value);
  filterEl.value?.focus();
}

const filterPlaceholder = computed(() =>
  browseFailed.value ? t('workspace.degradedPlaceholder') : t('workspace.searchPlaceholder'),
);

const footerHint = computed(() => {
  if (browseFailed.value) return t('workspace.degradedHint');
  if (isPathMode.value && pathState.value === 'valid') return t('workspace.pathFollowHint');
  return t('workspace.browseHint');
});

function handleFilterKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // First Esc clears the box (back to browsing); a second closes the dialog.
    if (filter.value) filter.value = '';
    else emit('close');
    return;
  }
  if (event.key !== 'Enter') return;
  const text = filter.value.trim();
  if (!isWorkspacePathInput(text)) return; // fuzzy search: Enter keeps doing nothing
  event.preventDefault();
  if (browseFailed.value) {
    const { target } = parseWorkspacePathInput(text, homePath.value);
    if (target) emit('add', target);
    return;
  }
  if (pathState.value === 'valid') openThisFolder();
  else if (pathState.value === 'not-found' && pathCandidates.value[0]) {
    pickCandidate(pathCandidates.value[0].name);
  }
}

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

const canOpen = computed(() => {
  if (currentPath.value.length === 0) return false;
  // In path mode only a validated target may be opened — otherwise the button
  // would submit the stale prefix the browser last followed to.
  if (isPathMode.value && validatedAddPath.value === null) return false;
  return true;
});

async function navigate(path?: string): Promise<void> {
  loading.value = true;
  try {
    const result = await props.browseFs(path);
    // A result with no path back means the daemon can't browse → degraded
    // mode, where the input box is the only way to add a path (the adapter
    // returns { path: '', parent: null, [] } on error).
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
  // Path mode submits the typed lexical root; browsing submits the (canonical)
  // folder the browser sits in — matching the removed paste field's semantics.
  emit('add', validatedAddPath.value ?? currentPath.value);
}

onMounted(async () => {
  loading.value = true;
  try {
    // $HOME up-front: needed for "~" expansion and as the browse fallback.
    const home = await props.getFsHome().catch(() => ({ home: '', recentRoots: [] as string[] }));
    if (home.home) homePath.value = home.home;
    // Default to the path kimi-web is working in; fall back to $HOME.
    if (props.defaultPath) {
      await navigate(props.defaultPath);
      if (!browseFailed.value) return;
    }
    if (homePath.value) {
      await navigate(homePath.value);
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
  if (pathTimer) clearTimeout(pathTimer);
});
</script>

<template>
  <Dialog v-model:open="open" :title="t('workspace.addTitle')" size="lg" height="fixed" @close="emit('close')">
    <div class="aw">
      <!-- Breadcrumb + up (hidden when the daemon can't browse) -->
      <div v-if="!browseFailed" class="crumbbar">
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

      <!-- One box for everything: fuzzy search across the whole current folder
           normally; absolute-path entry when the input looks absolute (POSIX,
           "~", Windows drive or UNC). Always visible — when the daemon can't
           browse it's the only way. -->
      <div
        v-if="!loading || browseFailed"
        class="filterbar"
        :class="{ 'has-error': pathState === 'not-found' || pathState === 'bad-parent' }"
      >
        <Icon class="filter-icon" name="search" size="md" />
        <input
          ref="filterEl"
          v-model="filter"
          class="filter-input"
          type="text"
          :placeholder="filterPlaceholder"
          autocomplete="off"
          spellcheck="false"
          @keydown.stop="handleFilterKeydown"
        />
        <Spinner v-if="searching || pathState === 'checking'" size="sm" />
      </div>

      <!-- Folder list. Fixed height → the dialog never resizes while searching. -->
      <div v-if="!browseFailed" class="folder-list">
        <div v-if="loading" class="fl-loading">{{ t('workspace.browsing') }}</div>

        <!-- Path mode: validation states. A valid path live-follows, so it falls
             through to the browse rows below. -->
        <template v-else-if="isPathMode && pathState !== 'valid'">
          <div v-if="pathState === 'checking'" class="fl-loading">{{ t('workspace.checkingPath') }}</div>
          <template v-else-if="pathState === 'not-found'">
            <div v-if="pathCandidates.length > 0" class="fl-note">{{ t('workspace.pathPickHint') }}</div>
            <button
              v-for="c in pathCandidates"
              :key="c.path"
              class="folder-row"
              @click="pickCandidate(c.name)"
            >
              <Icon class="dir-icon" name="folder-closed" size="sm" />
              <span class="folder-name">{{ c.name }}</span>
            </button>
            <div v-if="pathCandidates.length === 0" class="fl-empty fl-error">
              {{ t('workspace.noPathMatch', { parent: pathParent }) }}
            </div>
          </template>
          <div v-else-if="pathState === 'bad-parent'" class="fl-empty fl-error">
            {{ t('workspace.badParent', { parent: pathParent }) }}
          </div>
        </template>

        <!-- Search mode: recursive fuzzy hits (relative paths) -->
        <template v-else-if="isSearching && !isPathMode">
          <button
            v-for="hit in searchResults"
            :key="hit.path"
            class="folder-row"
            @click="navigate(hit.path)"
          >
            <Icon class="dir-icon" name="folder-closed" size="sm" />
            <span class="folder-name search-rel">{{ hit.rel }}</span>
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
          </button>
          <div v-if="entries.length === 0" class="fl-empty">{{ t('workspace.noSubfolders') }}</div>
        </template>
      </div>

      <!-- Degraded: the daemon can't browse — the box above is the only way. -->
      <div v-else class="degraded-hint">{{ t('workspace.degradedHint') }}</div>

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

      <div class="footer-hint">{{ footerHint }}</div>
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

/* Path-mode error: tint the shared box's border + icon. */
.filterbar.has-error { border-bottom-color: var(--color-danger); }
.filterbar.has-error .filter-icon { color: var(--color-danger); }

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
.fl-note {
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
.fl-error { color: var(--color-danger); }
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

/* Degraded mode (daemon can't browse): compact hint under the input box. */
.degraded-hint {
  padding: var(--space-6) var(--space-5);
  text-align: center;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

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
