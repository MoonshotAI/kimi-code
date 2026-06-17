<!-- apps/kimi-web/src/components/AddWorkspaceDialog.vue -->
<!-- Daemon-driven folder browser for adding a workspace: starts at $HOME -->
<!-- (fs:home), shows recent roots as quick-picks, a clickable breadcrumb, and -->
<!-- the folder list (fs:browse). "Open this folder" adds the current path. -->
<!-- Falls back to a paste-path escape hatch when the daemon can't browse. -->
<!-- Light only, monospace-forward, Kimi blue #1565C0, no emoji. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FsBrowseEntry, FsBrowseResult } from '../api/types';

const { t } = useI18n();

const props = defineProps<{
  browseFs: (path?: string) => Promise<FsBrowseResult>;
  getFsHome: () => Promise<{ home: string; recentRoots: string[] }>;
  /** Where the browser opens by default — the path kimi-web is working in. */
  defaultPath?: string;
}>();

const emit = defineEmits<{
  add: [root: string];
  close: [];
}>();

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

function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    emit('close');
  }
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
  if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <div class="dialog" role="dialog" :aria-label="t('workspace.addTitle')">
      <!-- Header -->
      <div class="dh">
        <span class="dtitle">{{ t('workspace.addTitle') }}</span>
        <button class="close-btn" :aria-label="t('workspace.cancel')" @click="emit('close')">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
            <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
          </svg>
        </button>
      </div>

      <!-- Folder browser -->
      <template v-if="!browseFailed">
        <!-- Breadcrumb + up -->
        <div class="crumbbar">
          <button
            class="up-btn"
            :disabled="!parentPath"
            :title="t('workspace.up')"
            :aria-label="t('workspace.up')"
            @click="goUp"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 12V4M4 7l4-3 4 3" />
            </svg>
          </button>
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
          <svg class="filter-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5"/><path d="M11 11l3 3"/>
          </svg>
          <input
            v-model="filter"
            class="filter-input"
            type="text"
            :placeholder="t('workspace.searchPlaceholder')"
            autocomplete="off"
            spellcheck="false"
            @keydown.stop
          />
          <span v-if="searching" class="search-spin" aria-hidden="true" />
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
              <svg class="dir-icon" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">
                <rect x="1" y="3.5" width="12" height="8.5" rx="1"/>
                <path d="M1 5V3.5A1 1 0 0 1 2 2.5h3.5l1.3 2"/>
              </svg>
              <span class="folder-name search-rel">{{ hit.rel }}</span>
              <span v-if="hit.isGitRepo" class="git-tag">
                {{ t('workspace.gitTag') }}<span v-if="hit.branch" class="git-branch"> {{ hit.branch }}</span>
              </span>
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
              <svg class="dir-icon" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2">
                <rect x="1" y="3.5" width="12" height="8.5" rx="1"/>
                <path d="M1 5V3.5A1 1 0 0 1 2 2.5h3.5l1.3 2"/>
              </svg>
              <span class="folder-name">{{ entry.name }}</span>
              <span v-if="entry.isGitRepo" class="git-tag">
                {{ t('workspace.gitTag') }}<span v-if="entry.branch" class="git-branch"> {{ entry.branch }}</span>
              </span>
            </button>
            <div v-if="entries.length === 0" class="fl-empty">{{ t('workspace.noSubfolders') }}</div>
          </template>
        </div>
      </template>

      <!-- Paste an absolute path — secondary, collapsed behind a toggle (always
           expanded when the daemon can't browse, since it's then the only way). -->
      <div class="paste-section" :class="{ 'paste-only': browseFailed }">
        <button
          v-if="!browseFailed && !pasteOpen"
          type="button"
          class="paste-toggle"
          @click="pasteOpen = true"
        >
          {{ t('workspace.pasteToggle') }}
        </button>
        <template v-else>
          <label class="paste-label" for="aw-path">{{ t('workspace.pathLabel') }}</label>
          <input
            id="aw-path"
            v-model="pathInput"
            class="paste-input"
            type="text"
            :placeholder="t('workspace.pathPlaceholder')"
            autocomplete="off"
            spellcheck="false"
            @keydown.enter.stop="handlePasteAdd"
          />
          <button class="paste-add" :disabled="pathTrimmed.length === 0" :title="t('workspace.add')" @click="handlePasteAdd">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 3v10M3 8h10"/>
            </svg>
          </button>
        </template>
      </div>

      <!-- Actions -->
      <div class="actions">
        <button
          v-if="!browseFailed"
          class="act-btn primary"
          :disabled="!canOpen"
          :title="currentPath"
          @click="openThisFolder"
        >{{ t('workspace.openThisFolder') }}</button>
        <button class="act-btn" @click="emit('close')">{{ t('workspace.cancel') }}</button>
      </div>

      <div class="footer-hint">{{ t('workspace.browseHint') }}</div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(20, 23, 28, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.dialog {
  position: relative;
  background: var(--bg);
  border-radius: 4px;
  width: 540px;
  max-width: calc(100vw - 32px);
  height: 520px;
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  font-family: var(--mono);
  box-shadow: inset 0 0 0 1px var(--line), 0 8px 32px rgba(0,0,0,0.14);
  overflow: hidden;
}

.dh {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.dtitle {
  font-size: calc(var(--ui-font-size) - 1.5px);
  font-weight: 700;
  color: var(--ink);
  flex: 1;
  letter-spacing: 0.02em;
}
.close-btn {
  background: none;
  border: none;
  color: var(--faint);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.close-btn:hover { color: var(--ink); }

/* Breadcrumb bar */
.crumbbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line2);
  background: var(--panel);
}
.up-btn {
  flex: none;
  width: 24px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--dim);
  cursor: pointer;
}
.up-btn:hover:not(:disabled) { color: var(--ink); border-color: var(--bd); }
.up-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 1px;
  min-width: 0;
  font-size: calc(var(--ui-font-size) - 3px);
}
.crumb-sep { color: var(--faint); }
.crumb {
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--dim);
  padding: 1px 3px;
  border-radius: 3px;
}
.crumb:hover { color: var(--blue); background: var(--panel2); }
.crumb.last { color: var(--ink); font-weight: 600; }

/* Subfolder filter */
.filterbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--line2);
}
.filter-icon { flex: none; color: var(--faint); }
.filter-input {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  padding: 3px 4px;
  border: none;
  background: none;
  color: var(--ink);
  outline: none;
}
.filter-input::placeholder { color: var(--faint); }
.search-spin {
  flex: none;
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--line);
  border-top-color: var(--blue);
  border-radius: 50%;
  animation: aw-spin 0.7s linear infinite;
}
@keyframes aw-spin { to { transform: rotate(360deg); } }
.search-rel { color: var(--ink); }

.paste-toggle {
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--blue);
  padding: 2px 0;
  text-align: left;
}
.paste-toggle:hover { text-decoration: underline; }

/* Folder list */
.folder-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0;
}
.fl-loading, .fl-empty {
  padding: 24px 14px;
  text-align: center;
  color: var(--faint);
  font-size: calc(var(--ui-font-size) - 3px);
}
.folder-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  color: var(--text);
  text-align: left;
  padding: 5px 14px;
}
.folder-row:hover { background: var(--panel2); }
.dir-icon { flex: none; color: var(--muted); }
.folder-row:hover .dir-icon { color: var(--blue); }
.folder-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
}
.git-tag {
  flex: none;
  display: inline-flex;
  align-items: center;
  background: var(--soft);
  color: var(--blue2);
  border: 1px solid var(--bd);
  border-radius: 9px;
  font-size: max(9px, calc(var(--ui-font-size) - 4.5px));
  line-height: 1;
  padding: 2px 6px;
}
.git-branch { color: var(--muted); }

/* Paste-path escape hatch */
.paste-section {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--line2);
}
.paste-section.paste-only { border-top: none; }
.paste-label { font-size: calc(var(--ui-font-size) - 3px); color: var(--dim); flex: none; }
.paste-input {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--panel);
  color: var(--ink);
  outline: none;
}
.paste-input:focus-visible {
  border-color: var(--blue);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--blue) 25%, transparent);
}

.paste-add {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: 1px solid var(--line);
  border-radius: 3px;
  cursor: pointer;
  color: var(--text);
}
.paste-add:hover:not(:disabled) { background: var(--panel2); border-color: var(--bd); }
.paste-add:disabled { opacity: 0.5; cursor: not-allowed; }

/* Actions */
.actions {
  display: flex;
  gap: 8px;
  padding: 0 14px 14px;
}
.act-btn {
  background: none;
  border: 1px solid var(--line);
  border-radius: 3px;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  padding: 5px 14px;
  cursor: pointer;
  color: var(--text);
}
.act-btn:hover:not(:disabled) { background: var(--panel2); }
.act-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.act-btn.primary {
  background: var(--blue);
  border-color: var(--blue);
  color: var(--bg);
  flex: 1;
}
.act-btn.primary:hover:not(:disabled) { background: var(--blue2); }
.footer-hint {
  padding: 6px 14px;
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  color: var(--faint);
  border-top: 1px solid var(--line2);
  background: var(--panel);
}

@media (max-width: 640px) {
  .backdrop {
    align-items: stretch;
    padding:
      max(12px, env(safe-area-inset-top))
      max(12px, env(safe-area-inset-right))
      max(12px, env(safe-area-inset-bottom))
      max(12px, env(safe-area-inset-left));
  }
  .dialog {
    width: 100%;
    max-width: none;
    height: auto;
    max-height: calc(100dvh - 24px);
  }
  .dh,
  .folder-row {
    min-height: 44px;
  }
  .crumbbar {
    align-items: flex-start;
  }
  .paste-section {
    align-items: stretch;
    flex-wrap: wrap;
  }
  .paste-label {
    flex: 1 0 100%;
  }
  .actions {
    flex-wrap: wrap;
    padding-bottom: max(14px, env(safe-area-inset-bottom));
  }
  .act-btn {
    min-height: 36px;
  }
  .act-btn.primary {
    flex: 1 1 100%;
  }
}
</style>
