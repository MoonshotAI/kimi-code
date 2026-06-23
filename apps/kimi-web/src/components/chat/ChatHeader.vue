<!-- apps/kimi-web/src/components/chat/ChatHeader.vue -->
<!-- Thin context bar above the chat: workspace / session name, git branch +
     status, "open in editor", and a ⋮ more-menu that bundles copy-all plus
     the same session actions available from the sidebar session row. -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard } from '../../lib/clipboard';

const { t } = useI18n();

const props = defineProps<{
  sessionId?: string;
  workspaceName?: string;
  /** Absolute path to the active workspace root. */
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
  copyAll: [];
  copyFinalSummary: [];
  openChanges: [];
  openPr: [url: string];
  renameSession: [id: string, title: string];
  forkSession: [id: string];
  archiveSession: [id: string];
}>();

const ahead = computed(() => props.ahead ?? 0);
const behind = computed(() => props.behind ?? 0);
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

function onCopyFinalSummary(): void {
  emit('copyFinalSummary');
  closeMenu();
}

// ---------------------------------------------------------------------------
// Copy session ID
// ---------------------------------------------------------------------------
const copiedId = ref(false);
function copySessionId(): void {
  if (!props.sessionId) return;
  void copyTextToClipboard(props.sessionId).then((ok) => {
    if (!ok) return;
    copiedId.value = true;
    setTimeout(() => {
      copiedId.value = false;
    }, 1200);
  });
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
      :aria-label="t('header.options')"
      :aria-expanded="menuOpen"
      aria-haspopup="menu"
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
      <button type="button" class="chm-item" @click.stop="onCopyFinalSummary">
        {{ t('header.copyFinalSummary') }}
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

    <!-- Git branch + status — plain text with semantic colors. Renders for any
         git repo, even a detached HEAD (empty branch → "detached" label), so the
         diff counter below is never hidden just because there's no branch name. -->
    <button
      v-if="isGitRepo"
      type="button"
      class="ch-git"
      :title="t('header.gitTooltip')"
      @click="emit('openChanges')"
    >
      <span
        class="ch-branch"
        :class="{ 'ch-detached': !branch }"
        :title="branch || t('header.detached')"
      >
        {{ branch || t('header.detached') }}
      </span>
      <span v-if="ahead > 0 || behind > 0" class="ch-pill ch-sync-pill">
        <span v-if="ahead > 0" class="ch-ahead">↑{{ ahead }}</span>
        <span v-if="behind > 0" class="ch-behind">↓{{ behind }}</span>
      </span>
      <span v-if="hasLineStats" class="ch-pill ch-diff-pill">
        <span v-if="adds > 0" class="ch-add">+{{ adds }}</span>
        <span v-if="dels > 0" class="ch-del">-{{ dels }}</span>
      </span>
    </button>

    <!-- GitHub PR status -->
    <button
      v-if="pr"
      type="button"
      class="ch-pill ch-pr"
      :class="`pr-${pr.state}`"
      :title="t('header.openPr')"
      @click="pr && emit('openPr', pr.url)"
    >
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="5" cy="6" r="3" />
        <path d="M5 9v12" />
        <circle cx="19" cy="18" r="3" />
        <path d="m15 9-3-3 3-3" />
        <path d="M12 6h5a2 2 0 0 1 2 2v7" />
      </svg>
      <span>PR #{{ pr.number }} · {{ pr.state }}</span>
    </button>

  </header>
</template>

<style scoped>
.chat-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  height: 48px;
  padding: 0 16px;
  border-bottom: 1px solid var(--line);
  background: var(--bg);
  font-family: var(--sans);
  min-width: 0;
}
.ch-id { display: flex; align-items: center; gap: 6px; min-width: 0; flex: none; max-width: 46%; }
.ch-ws { color: var(--muted); font-size: var(--ui-font-size-sm); flex: none; }
.ch-sep { color: var(--faint); flex: none; }
.ch-ses {
  color: var(--ink);
  font-size: var(--ui-font-size-sm);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch-rename {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: var(--ui-font-size-sm);
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
  gap: 4px;
  border: none;
  background: transparent;
  padding: 0;
  color: var(--muted);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 2px);
  flex: 0 1 auto;
  max-width: none;
  min-width: 0;
  cursor: pointer;
}
.ch-git:hover .ch-branch { color: var(--ink); }
.ch-branch {
  color: var(--dim);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-right: 4px;
}
.ch-detached { color: var(--muted); font-style: italic; }
.ch-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--panel);
  border: 1px solid var(--line);
  font-size: calc(var(--ui-font-size) - 3px);
}
.ch-sync-pill { border-color: var(--line); }
.ch-diff-pill { border-color: color-mix(in srgb, var(--ok) 20%, var(--line)); }
.ch-ahead { color: var(--warn); flex: none; }
.ch-behind { color: var(--blue2); flex: none; }
.ch-add { color: var(--ok); flex: none; }
.ch-del { color: var(--err); flex: none; }
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
  font-size: var(--ui-font-size-xs);
  padding: 0;
  cursor: pointer;
}
.ch-act:hover { color: var(--ink); }
.ch-act.open { color: var(--ink); }
.ch-act svg { flex: none; }
/* Kebab is icon-only: keep the glyph small but give it a comfortable 28x28
   click target (and a clear keyboard focus ring). */
.ch-act-more {
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
}
.ch-act-more:hover { background: var(--panel2); }
.ch-act-more:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
}

.ch-pr {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
  cursor: pointer;
  color: var(--dim);
  margin-left: -4px;
  font-size: calc(var(--ui-font-size) - 2.5px);
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
  font-size: calc(var(--ui-font-size) - 3px);
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
