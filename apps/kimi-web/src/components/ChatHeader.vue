<!-- apps/kimi-web/src/components/ChatHeader.vue -->
<!-- Thin context bar above the chat: workspace / session name, git branch +
     status, "open in editor", and a ⋮ more-menu that bundles copy-all plus
     the same session actions available from the sidebar session row. -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import OpenInMenu from './OpenInMenu.vue';

const { t } = useI18n();

const props = defineProps<{
  sessionId?: string;
  workspaceName?: string;
  /** Absolute path to the active workspace root (shown in the Open menu). */
  workspaceRoot?: string;
  sessionTitle?: string;
  branch?: string;
  ahead?: number;
  behind?: number;
  changesCount?: number;
  /** Git diff line stats: additions / deletions. Zero/null values are hidden. */
  gitDiffStats?: { totalAdditions: number; totalDeletions: number } | null;
  isGitRepo?: boolean;
  /** GitHub PR for the current branch, when known (null/undefined = none). */
  pr?: { number: number; state: string; url: string } | null;
  /** True for ~2s after a successful copy-all, to flip the icon to a check. */
  copied?: boolean;
}>();

const emit = defineEmits<{
  openInApp: [appId: string];
  copyAll: [];
  openPr: [url: string];
  renameSession: [id: string, title: string];
  forkSession: [id: string];
  archiveSession: [id: string];
}>();

const ahead = computed(() => props.ahead ?? 0);
const behind = computed(() => props.behind ?? 0);
const changes = computed(() => props.changesCount ?? 0);
const adds = computed(() => props.gitDiffStats?.totalAdditions ?? 0);
const dels = computed(() => props.gitDiffStats?.totalDeletions ?? 0);
const hasLineStats = computed(() => adds.value > 0 || dels.value > 0);

// ---------------------------------------------------------------------------
// More-menu (kebab dropdown)
// ---------------------------------------------------------------------------
const menuOpen = ref(false);
const kebabRef = ref<HTMLButtonElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);
const menuStyle = ref<Record<string, string>>({});

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.contains(target) || kebabRef.value?.contains(target)) return;
  closeMenu();
}

function onScrollOrResize(): void {
  closeMenu();
}

async function toggleMenu(e: Event): Promise<void> {
  e.stopPropagation();
  if (menuOpen.value) {
    closeMenu();
    return;
  }
  menuOpen.value = true;
  document.addEventListener('mousedown', onDocClick);
  document.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize);
  await nextTick();
  const btn = kebabRef.value;
  const menu = menuRef.value;
  if (!btn || !menu) return;
  const r = btn.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;
  let top = r.bottom + gap;
  if (top + menuH > window.innerHeight - margin) {
    top = Math.max(margin, r.top - menuH - gap);
  }
  let left = r.left;
  if (left + menuW > window.innerWidth - margin) {
    left = Math.max(margin, r.right - menuW);
  }
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  };
}

function closeMenu(): void {
  menuOpen.value = false;
  disarmDelete();
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('scroll', onScrollOrResize, true);
  window.removeEventListener('resize', onScrollOrResize);
}

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('scroll', onScrollOrResize, true);
  window.removeEventListener('resize', onScrollOrResize);
});

function onCopyAll(): void {
  emit('copyAll');
  closeMenu();
}

// ---------------------------------------------------------------------------
// Copy session ID
// ---------------------------------------------------------------------------
const copiedId = ref(false);
function copySessionId(): void {
  if (!props.sessionId) return;
  navigator.clipboard.writeText(props.sessionId).then(() => {
    copiedId.value = true;
    setTimeout(() => {
      copiedId.value = false;
    }, 1200);
  }).catch(() => { /* ignore */ });
}

// ---------------------------------------------------------------------------
// Inline rename (mirrors SessionRow)
// ---------------------------------------------------------------------------
const renaming = ref(false);
const renameValue = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);

async function startRename(): Promise<void> {
  closeMenu();
  if (!props.sessionId) return;
  renaming.value = true;
  renameValue.value = props.sessionTitle ?? '';
  await nextTick();
  try {
    renameInputRef.value?.focus();
    renameInputRef.value?.select();
  } catch {
    // jsdom may not implement focus/select
  }
}

function commitRename(): void {
  const newTitle = renameValue.value.trim();
  if (newTitle && props.sessionId && newTitle !== (props.sessionTitle ?? '').trim()) {
    emit('renameSession', props.sessionId, newTitle);
  }
  renaming.value = false;
}

function cancelRename(): void {
  renaming.value = false;
}

// ---------------------------------------------------------------------------
// Fork
// ---------------------------------------------------------------------------
function forkSession(): void {
  if (!props.sessionId) return;
  closeMenu();
  emit('forkSession', props.sessionId);
}

// ---------------------------------------------------------------------------
// Archive (two-step confirm, same pattern as the workspace menus)
// ---------------------------------------------------------------------------
const deleteArmed = ref(false);
let deleteArmTimer: ReturnType<typeof setTimeout> | undefined;

function disarmDelete(): void {
  clearTimeout(deleteArmTimer);
  deleteArmed.value = false;
}

function startArchive(): void {
  if (!props.sessionId) return;
  if (deleteArmed.value) {
    emit('archiveSession', props.sessionId);
    closeMenu();
    return;
  }
  deleteArmed.value = true;
  deleteArmTimer = setTimeout(() => {
    deleteArmed.value = false;
  }, 2500);
}
</script>

<template>
  <header class="chat-header">
    <!-- Workspace / session breadcrumb -->
    <div class="ch-id">
      <span v-if="workspaceName" class="ch-ws">{{ workspaceName }}</span>
      <span v-if="workspaceName && sessionTitle" class="ch-sep">/</span>
      <input
        v-if="renaming"
        ref="renameInputRef"
        v-model="renameValue"
        class="ch-rename"
        type="text"
        @keydown.enter.stop="commitRename"
        @keydown.esc.stop="cancelRename"
        @blur="commitRename"
        @click.stop
      />
      <span v-else-if="sessionTitle" class="ch-ses" :title="sessionTitle">{{ sessionTitle }}</span>
    </div>

    <!-- More menu trigger: copy-all + session actions -->
    <button
      ref="kebabRef"
      type="button"
      class="ch-act ch-act-more"
      :class="{ open: menuOpen }"
      :title="t('header.options')"
      @click.stop="toggleMenu($event)"
    >
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <circle cx="3" cy="8" r="1.3" />
        <circle cx="8" cy="8" r="1.3" />
        <circle cx="13" cy="8" r="1.3" />
      </svg>
    </button>

    <!-- Fixed more menu -->
    <div
      v-if="menuOpen"
      ref="menuRef"
      class="ch-menu"
      :style="menuStyle"
      @click.stop
    >
      <button type="button" class="chm-item" @click.stop="onCopyAll">
        {{ copied ? t('header.copied') : t('header.copyAll') }}
      </button>
      <template v-if="sessionId">
        <div class="chm-divider" />
        <button type="button" class="chm-item" @click.stop="copySessionId">
          <span>{{ copiedId ? t('header.copied') : t('header.copySessionId') }}</span>
        </button>
        <button type="button" class="chm-item" @click.stop="startRename">
          {{ t('header.renameSession') }}
        </button>
        <button type="button" class="chm-item" @click.stop="forkSession">
          {{ t('header.forkSession') }}
        </button>
        <button type="button" class="chm-item del" @click.stop="startArchive">
          {{ deleteArmed ? t('header.confirmArchive') : t('header.archiveSession') }}
        </button>
      </template>
    </div>

    <div class="ch-spacer" />

    <!-- Git branch + status — plain text with semantic colors -->
    <div v-if="isGitRepo && branch" class="ch-git" :title="t('header.gitTooltip')">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <circle cx="4" cy="4" r="1.7" /><circle cx="4" cy="12" r="1.7" /><circle cx="12" cy="6" r="1.7" />
        <path d="M4 5.7v4.6M5.7 4H9a2 2 0 0 1 2 2v.3" />
      </svg>
      <span class="ch-branch">{{ branch }}</span>
      <span v-if="ahead > 0" class="ch-ahead">↑{{ ahead }}</span>
      <span v-if="behind > 0" class="ch-behind">↓{{ behind }}</span>
      <template v-if="hasLineStats">
        <span v-if="adds > 0" class="ch-add">+{{ adds }}</span>
        <span v-if="dels > 0" class="ch-del">-{{ dels }}</span>
      </template>
      <span v-else-if="changes > 0" class="ch-changes">{{ t('header.changed', { n: changes }) }}</span>
    </div>

    <!-- GitHub PR status -->
    <button
      v-if="pr"
      type="button"
      class="ch-pr"
      :class="`pr-${pr.state}`"
      :title="t('header.openPr')"
      @click="pr && emit('openPr', pr.url)"
    >
      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
        <path d="M11.5 4.5a2 2 0 1 0-2.7 1.86V9.6A2 2 0 1 0 10 11.5V6.36A2 2 0 0 0 11.5 4.5zM4.5 2.5a2 2 0 0 0-.7 3.86v3.28a2 2 0 1 0 1.4 0V6.36A2 2 0 0 0 4.5 2.5z"/>
      </svg>
      <span>PR #{{ pr.number }} · {{ pr.state }}</span>
    </button>

    <!-- Open workspace in an external app (style + behaviour mirrors kimi-cli/web).
         Temporarily hidden while the feature is being refined. -->
    <OpenInMenu v-if="sessionId && false" :work-dir="workspaceRoot" @open-in-app="(app) => emit('openInApp', app)" />
  </header>
</template>

<style scoped>
.chat-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 38px;
  padding: 0 14px;
  border-bottom: 1px solid var(--line);
  background: var(--bg);
  font-family: var(--sans);
  min-width: 0;
}
.ch-id { display: flex; align-items: center; gap: 6px; min-width: 0; flex: none; max-width: 46%; }
.ch-ws { color: var(--muted); font-size: 12.5px; flex: none; }
.ch-sep { color: var(--faint); flex: none; }
.ch-ses {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch-rename {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
  background: var(--bg);
  border: 1px solid var(--blue);
  border-radius: 3px;
  padding: 2px 5px;
  outline: none;
}
.ch-git {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11.5px;
  min-width: 0;
}
.ch-git svg { flex: none; }
.ch-branch { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
.ch-ahead { color: var(--warn); flex: none; }
.ch-behind { color: var(--blue2); flex: none; }
.ch-changes {
  flex: none;
  color: var(--warn);
}
.ch-add {
  flex: none;
  color: var(--ok);
}
.ch-del {
  flex: none;
  color: var(--err);
}
.ch-spacer { flex: 1; min-width: 0; }

.ch-act {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--dim);
  font-family: var(--sans);
  font-size: 12px;
  padding: 0;
  cursor: pointer;
}
.ch-act:hover { color: var(--ink); }
.ch-act.open { color: var(--ink); }
.ch-act svg { flex: none; }

.ch-pr {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg);
  font-family: var(--mono);
  font-size: 11px;
  padding: 2px 9px;
  cursor: pointer;
  color: var(--dim);
}
.ch-pr.pr-open { color: #1a7f37; border-color: color-mix(in srgb, #1a7f37 30%, var(--line)); }
.ch-pr.pr-merged { color: #8250df; border-color: color-mix(in srgb, #8250df 30%, var(--line)); }
.ch-pr.pr-closed { color: var(--err); }
.ch-pr:hover { background: var(--soft); }

/* Fixed more-menu, anchored to the kebab trigger */
.ch-menu {
  position: fixed;
  top: 0;
  left: 0;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  z-index: 200;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  overflow: hidden;
  min-width: 140px;
}
.chm-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink);
  padding: 6px 12px;
}
.chm-item:hover { background: var(--panel2); }
.chm-item.del { color: var(--err); }
.chm-item.del:hover { background: color-mix(in srgb, var(--err) 10%, transparent); }

.chm-divider {
  height: 1px;
  background: var(--line);
  margin: 2px 0;
}

/* On a narrow conversation column, the action labels collapse to icons. */
@media (max-width: 900px) {
  .ch-act-label { display: none; }
}
@media (max-width: 640px) {
  .chat-header { display: none; }
}
</style>
