<!-- apps/kimi-web/src/components/AddWorkspaceDialog.vue -->
<!-- Daemon-driven folder browser for adding a workspace: starts at $HOME -->
<!-- (fs:home), shows recent roots as quick-picks, a clickable breadcrumb, and -->
<!-- the folder list (fs:browse). "Open this folder" adds the current path. -->
<!-- Falls back to a paste-path escape hatch when the daemon can't browse. -->
<!-- Light only, monospace-forward, Kimi blue #1565C0, no emoji. -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FsBrowseEntry, FsBrowseResult } from '../api/types';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    recentRoots: string[];
    browseFs: (path?: string) => Promise<FsBrowseResult>;
    getFsHome: () => Promise<{ home: string; recentRoots: string[] }>;
  }>(),
  { recentRoots: () => [] },
);

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
const recent = ref<string[]>([...props.recentRoots]);

// Paste-path escape hatch
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

function pickRecent(root: string): void {
  void navigate(root);
}

function handlePasteAdd(): void {
  if (pathTrimmed.value.length === 0) return;
  emit('add', pathTrimmed.value);
}

onMounted(async () => {
  loading.value = true;
  try {
    const home = await props.getFsHome();
    if (home.recentRoots.length > 0) recent.value = home.recentRoots;
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
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));
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

      <!-- Recent roots quick-pick -->
      <div v-if="recent.length > 0" class="recent-section">
        <div class="recent-label">{{ t('workspace.recentLabel') }}</div>
        <div class="recent-list">
          <button
            v-for="root in recent"
            :key="root"
            class="recent-chip"
            :title="root"
            @click="pickRecent(root)"
          >
            <svg class="dir-icon" width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.2">
              <rect x="1" y="3" width="9" height="6.5" rx="1"/>
              <path d="M1 4.5V3a1 1 0 0 1 1-1h2.5l1 1.5"/>
            </svg>
            <span class="recent-path">{{ root }}</span>
          </button>
        </div>
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

        <!-- Folder list -->
        <div class="folder-list">
          <div v-if="loading" class="fl-loading">{{ t('workspace.browsing') }}</div>
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

      <!-- Paste-path fallback (always available as an escape hatch) -->
      <div class="paste-section" :class="{ 'paste-only': browseFailed }">
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
        <button class="paste-add" :disabled="pathTrimmed.length === 0" @click="handlePasteAdd">{{ t('workspace.add') }}</button>
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
  background: var(--bg);
  border: 1px solid var(--line);
  border-top: 2px solid var(--blue);
  border-radius: 4px;
  width: 540px;
  max-width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  font-family: var(--mono);
  box-shadow: 0 8px 32px rgba(0,0,0,0.14);
}
.dh {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.dtitle {
  font-size: 12.5px;
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

/* Recent roots */
.recent-section {
  padding: 10px 14px 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-bottom: 1px solid var(--line2);
}
.recent-label {
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.recent-list { display: flex; flex-wrap: wrap; gap: 5px; }
.recent-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 2px 9px 2px 7px;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text);
  max-width: 100%;
}
.recent-chip:hover { background: var(--soft); border-color: var(--bd); color: var(--blue); }
.recent-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

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
  font-size: 11px;
}
.crumb-sep { color: var(--faint); }
.crumb {
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--dim);
  padding: 1px 3px;
  border-radius: 3px;
}
.crumb:hover { color: var(--blue); background: var(--panel2); }
.crumb.last { color: var(--ink); font-weight: 600; }

/* Folder list */
.folder-list {
  max-height: 280px;
  min-height: 120px;
  overflow-y: auto;
  padding: 4px 0;
}
.fl-loading, .fl-empty {
  padding: 24px 14px;
  text-align: center;
  color: var(--faint);
  font-size: 11px;
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
  font-size: 14px;
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
  font-size: 9.5px;
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
.paste-label { font-size: 11px; color: var(--dim); flex: none; }
.paste-input {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 14px;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--panel);
  color: var(--ink);
  outline: none;
}
.paste-input:focus { border-color: var(--blue); }
.paste-add {
  flex: none;
  background: none;
  border: 1px solid var(--line);
  border-radius: 3px;
  font-family: var(--mono);
  font-size: 11.5px;
  padding: 5px 12px;
  cursor: pointer;
  color: var(--text);
}
.paste-add:hover:not(:disabled) { background: var(--panel2); }
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
  font-size: 12px;
  padding: 5px 14px;
  cursor: pointer;
  color: var(--text);
}
.act-btn:hover:not(:disabled) { background: var(--panel2); }
.act-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.act-btn.primary {
  background: var(--blue);
  border-color: var(--blue);
  color: #fff;
  flex: 1;
}
.act-btn.primary:hover:not(:disabled) { background: var(--blue2); }
.footer-hint {
  padding: 6px 14px;
  font-size: 10.5px;
  color: var(--faint);
  border-top: 1px solid var(--line2);
  background: var(--panel);
  border-radius: 0 0 4px 4px;
}
</style>
