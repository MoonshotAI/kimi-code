<!-- apps/web/src/components/chat/ChatHeader.vue -->
<!-- Thin context bar above the chat: workspace / session name, git branch +
     status, "open in editor", and a ⋮ more-menu that bundles copy-all plus
     the same session actions available from the sidebar session row. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { useSidebarTabs } from '@moonshot-ai/app-core';
import { isMacosDesktop } from '@moonshot-ai/app-core/lib';
import { canOpenInNative, listNativeOpenInApps, openInNativeApp } from '../../lib/nativeOpenIn';
import { track } from '../../lib/track';
import OpenInMenu from './OpenInMenu.vue';
import { useNativeTerminal } from '../../composables/useNativeTerminal';
import { Button, Icon, IconButton, Menu, MenuItem, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';

const { t } = useI18n();

// 实验室开关「多标签页侧边栏」：关（单列表形态）时归档动作用回旧「归档」
// 外观，已完成 pill / 恢复入口不显示（恢复在 设置→已归档）。
const { sidebarTabs } = useSidebarTabs();

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
  /** True when the session is archived (completed) — the header shows a Done
   *  pill + quiet reopen button for a completed session. Reachable via a
   *  remote archive while open or a deep link (the local flow switches away
   *  from the session it completes). */
  archived?: boolean;
}>();

const emit = defineEmits<{
  copyAll: [];
  copyFinalSummary: [];
  openChanges: [];
  openPr: [url: string];
  renameSession: [id: string, title: string];
  forkSession: [id: string];
  archiveSession: [id: string];
  /** Reopen a done (archived) session — the inverse of archiveSession. */
  restoreSession: [id: string];
  exportSession: [id: string];
}>();

const ahead = computed(() => props.ahead ?? 0);
const behind = computed(() => props.behind ?? 0);
const adds = computed(() => props.gitDiffStats?.totalAdditions ?? 0);
const dels = computed(() => props.gitDiffStats?.totalDeletions ?? 0);
const hasLineStats = computed(() => adds.value > 0 || dels.value > 0);
const PR_STATE_LABEL_KEYS: Record<string, string> = {
  open: 'header.prStatusOpen',
  closed: 'header.prStatusClosed',
  merged: 'header.prStatusMerged',
  draft: 'header.prStatusDraft',
};

function normalizedPrState(state: string): string {
  return state.trim().toLowerCase().replaceAll('_', '-');
}

function prStateClass(state: string): string {
  const stateClass = normalizedPrState(state);
  return PR_STATE_LABEL_KEYS[stateClass] ? `pr-${stateClass}` : 'pr-unknown';
}

function prStateLabel(state: string): string {
  return t(PR_STATE_LABEL_KEYS[normalizedPrState(state)] ?? 'header.prStatusUnknown');
}

// ---------------------------------------------------------------------------
// More-menu (kebab dropdown)
// ---------------------------------------------------------------------------
const menuOpen = ref(false);
const kebabRef = ref<InstanceType<typeof IconButton> | null>(null);
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const menuStyle = ref<Record<string, string>>({});

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.el?.contains(target) || kebabRef.value?.el?.contains(target)) return;
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
  window.addEventListener('resize', onScrollOrResize);
  await nextTick();
  const btn = kebabRef.value?.el;
  const menu = menuRef.value?.el;
  if (!btn || !menu) return;
  const r = btn.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;
  let top = r.bottom + gap;
  let flipped = false;
  if (top + menuH > window.innerHeight - margin) {
    top = Math.max(margin, r.top - menuH - gap);
    flipped = true;
  }
  let left = r.left;
  let alignRight = false;
  if (left + menuW > window.innerWidth - margin) {
    left = Math.max(margin, r.right - menuW);
    alignRight = true;
  }
  // The pop animation grows out of the trigger corner — the origin and the
  // nudge direction follow the anchoring (and the upward flip).
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    transformOrigin: `${flipped ? 'bottom' : 'top'} ${alignRight ? 'right' : 'left'}`,
    '--menu-pop-shift': flipped ? '2px' : '-2px',
  };
}

function closeMenu(): void {
  menuOpen.value = false;
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('resize', onScrollOrResize);
}

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('resize', onScrollOrResize);
});

function onCopyAll(): void {
  track('session_menu_action', { action: 'copyAll' });
  emit('copyAll');
  closeMenu();
}

function onCopyFinalSummary(): void {
  track('session_menu_action', { action: 'copyFinalSummary' });
  emit('copyFinalSummary');
  closeMenu();
}

// ---------------------------------------------------------------------------
// Copy session ID
// ---------------------------------------------------------------------------
const copiedId = ref(false);
function copySessionId(): void {
  if (!props.sessionId) return;
  track('session_menu_action', { action: 'copySessionId' });
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
// IME guard: Enter that only confirms a composition candidate must not commit.
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

async function startRename(): Promise<void> {
  closeMenu();
  if (!props.sessionId) return;
  track('session_menu_action', { action: 'rename' });
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
function onRenameEnter(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;
  commitRename();
}

function cancelRename(): void {
  renaming.value = false;
}

// ---------------------------------------------------------------------------
// Fork
// ---------------------------------------------------------------------------
function forkSession(): void {
  if (!props.sessionId) return;
  track('session_menu_action', { action: 'fork' });
  closeMenu();
  emit('forkSession', props.sessionId);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function exportSession(): void {
  if (!props.sessionId) return;
  track('session_menu_action', { action: 'export' });
  closeMenu();
  emit('exportSession', props.sessionId);
}

// ---------------------------------------------------------------------------
// Archive ("mark as done") — no confirm; App.vue (archiveSessionWithToast)
// archives directly and shows the undo toast. The header only emits the intent.
// ---------------------------------------------------------------------------
function startArchive(): void {
  if (!props.sessionId) return;
  track('session_menu_action', { action: 'archive' });
  closeMenu();
  emit('archiveSession', props.sessionId);
}

// Reopen a done session (the header's Done-state button).
function startRestore(): void {
  if (!props.sessionId) return;
  track('session_menu_action', { action: 'restore' });
  closeMenu();
  emit('restoreSession', props.sessionId);
}

// Git changes / PR header buttons — tracked with the same session_menu_action
// vocabulary as the ⋮ menu items.
function onOpenChanges(): void {
  track('session_menu_action', { action: 'openChanges' });
  emit('openChanges');
}

function onOpenPr(): void {
  if (!props.pr) return;
  track('session_menu_action', { action: 'openPr' });
  emit('openPr', props.pr.url);
}

// Dev-environment marker: only compiled into dev-server builds
// (`import.meta.env.DEV`), tree-shaken out of production bundles.
const isDev = import.meta.env.DEV;

// ---------------------------------------------------------------------------
// Open-in-app (desktop-only fork): the catalog comes from the main process,
// never from the daemon. Empty catalog (non-desktop / non-macOS) hides the
// whole control.
// ---------------------------------------------------------------------------
const openInApps = ref<Array<{ id: string; label: string }>>([]);

onMounted(async () => {
  if (canOpenInNative()) {
    openInApps.value = await listNativeOpenInApps();
  }
});

const showOpenIn = computed(() => openInApps.value.length > 0 && Boolean(props.workspaceRoot));

async function onOpenInApp(appId: string): Promise<void> {
  if (!props.workspaceRoot) return;
  await openInNativeApp(appId, props.workspaceRoot);
}

// Native terminal toggle (desktop-only fork): the bridge-probing store hides
// the button entirely on web / old bridges.
const terminalStore = useNativeTerminal();

function toggleTerminalPanel(): void {
  terminalStore.toggle(props.workspaceRoot);
}
</script>

<template>
  <header class="chat-header" :class="{ 'macos-desktop': isMacosDesktop }">
    <!-- Workspace / session breadcrumb -->
    <div class="ch-id">
      <!-- Dev-environment badge (dev builds only): leads the breadcrumb. -->
      <span v-if="isDev" class="ch-dev" :title="t('header.devBadge')">DEV</span>
      <span v-if="workspaceName" class="ch-ws">{{ workspaceName }}</span>
      <span v-if="workspaceName && sessionTitle" class="ch-sep">/</span>
      <input
        v-if="renaming"
        ref="renameInputRef"
        v-model="renameValue"
        class="ch-rename"
        type="text"
        @keydown.enter.stop="onRenameEnter"
        @keydown.esc.stop="cancelRename"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
        @blur="commitRename"
        @click.stop
      />
      <Tooltip v-else-if="sessionTitle" :text="sessionTitle">
        <span class="ch-ses">{{ sessionTitle }}</span>
      </Tooltip>
    </div>

    <!-- More menu trigger: copy-all + session actions -->
    <IconButton
      ref="kebabRef"
      class="ch-act-more"
      :class="{ open: menuOpen }"
      :label="t('header.options')"
      :tooltip="t('header.options')"
      :aria-expanded="menuOpen"
      aria-haspopup="menu"
      @click.stop="toggleMenu($event)"
    >
      <Icon name="dots-horizontal" size="sm" />
    </IconButton>

    <!-- Fixed more menu -->
    <Transition name="menu-pop">
      <Menu
        v-if="menuOpen"
        ref="menuRef"
        class="ch-menu"
        :style="menuStyle"
        @click.stop
      >
      <MenuItem @click="onCopyAll">
        <Icon :name="copied ? 'check' : 'copy'" size="sm" />
        {{ copied ? t('header.copied') : t('header.copyAll') }}
      </MenuItem>
      <MenuItem @click="onCopyFinalSummary">
        <Icon name="file-text" size="sm" />
        {{ t('header.copyFinalSummary') }}
      </MenuItem>
      <template v-if="sessionId">
        <MenuItem separator />
        <MenuItem @click="copySessionId">
          <Icon :name="copiedId ? 'check' : 'copy'" size="sm" />
          {{ copiedId ? t('header.copied') : t('header.copySessionId') }}
        </MenuItem>
        <MenuItem @click="startRename">
          <Icon name="pencil" size="sm" />
          {{ t('header.renameSession') }}
        </MenuItem>
        <MenuItem @click="forkSession">
          <Icon name="git-fork" size="sm" />
          {{ t('header.forkSession') }}
        </MenuItem>
        <MenuItem @click="exportSession">
          <Icon name="download" size="sm" />
          {{ t('header.exportSession') }}
        </MenuItem>
        <MenuItem v-if="archived && sidebarTabs" @click="startRestore">
          <Icon name="undo" size="sm" />
          {{ t('header.reopenSession') }}
        </MenuItem>
        <MenuItem v-if="!archived" @click="startArchive">
          <Icon :name="sidebarTabs ? 'state-done' : 'archive'" size="sm" />
          {{ sidebarTabs ? t('header.markSessionDone') : t('header.archiveSession') }}
        </MenuItem>
      </template>
      </Menu>
    </Transition>

    <div class="ch-spacer" />

    <!-- Open workspace in editor/terminal (desktop-only fork; hidden otherwise) -->
    <OpenInMenu
      v-if="showOpenIn"
      :work-dir="workspaceRoot"
      :available-apps="openInApps"
      @open-in-app="onOpenInApp"
    />

    <!-- Toggle the bottom terminal panel (desktop-only fork; hidden otherwise) -->
    <IconButton
      v-if="terminalStore.available"
      class="ch-terminal"
      :class="{ open: terminalStore.open.value }"
      :label="t('terminal.toggle')"
      :tooltip="t('terminal.toggle')"
      @click="toggleTerminalPanel"
    >
      <Icon name="terminal" size="sm" />
    </IconButton>

    <!-- Git branch + status — plain text with semantic colors. Renders for any
         git repo, even a detached HEAD (empty branch → "detached" label), so the
         diff counter below is never hidden just because there's no branch name. -->
    <button
      v-if="isGitRepo"
      type="button"
      class="ch-git"
      @click="onOpenChanges"
    >
      <Icon class="ch-branch-icon" name="git-fork" size="sm" />
      <span
        class="ch-branch"
        :class="{ 'ch-detached': !branch }"
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
      :class="prStateClass(pr.state)"
      @click="onOpenPr"
    >
      <Icon name="git-pull-request" size="sm" />
      <span>PR #{{ pr.number }} · {{ prStateLabel(pr.state) }}</span>
    </button>

    <!-- 已完成 state — display-only Done pill + a quiet reopen, shown only
         when viewing a completed session (the ⋯ menu carries 标记完成).
         单列表形态（实验室开关关）不显示——旧形态没有已完成词汇。 -->
    <template v-if="sessionId && archived && sidebarTabs">
      <span class="ch-pill ch-pr pr-merged ch-done-pill">
        <Icon name="state-done" size="sm" />
        <span>{{ t('header.sessionDone') }}</span>
      </span>
      <Button variant="secondary" size="sm" @click="startRestore">
        <Icon name="undo" size="sm" />
        {{ t('header.reopenSession') }}
      </Button>
    </template>

  </header>
</template>

<style scoped>
.chat-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  height: var(--panel-head-h, 48px);
  padding: 0 16px;
  border-bottom: 0.5px solid var(--color-line);
  background: var(--color-bg);
  font-family: var(--font-ui);
  min-width: 0;
  user-select: none;
  container-type: inline-size;
}
/* macOS desktop: the window has a hidden title bar, so the conversation header
   doubles as a window-drag region. Interactive controls opt out with no-drag. */
.chat-header.macos-desktop {
  -webkit-app-region: drag;
}
.chat-header.macos-desktop button,
.chat-header.macos-desktop input {
  -webkit-app-region: no-drag;
}
.ch-id { display: flex; align-items: center; gap: 6px; min-width: 0; flex: none; max-width: 46%; }
.ch-ws { color: var(--color-text-muted); font-size: var(--text-base); font-weight: var(--weight-medium); flex: none; }
.ch-sep { color: var(--color-text-faint); flex: none; }
.ch-ses {
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch-rename {
  flex: 1;
  min-width: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  background: var(--color-bg);
  border: 0.5px solid var(--color-accent);
  border-radius: var(--radius-xs);
  padding: 2px 5px;
  outline: none;
  user-select: text;
}

.ch-git {
  display: flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  padding: 0;
  color: var(--muted);
  font-family: var(--font-ui);
  font-size: calc(var(--ui-font-size) - 2px);
  flex: 0 1 auto;
  max-width: none;
  min-width: 0;
  cursor: pointer;
}
.ch-git:hover .ch-branch { color: var(--color-text); }
.ch-branch-icon { flex: none; color: var(--color-text-muted); }
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
  border: 0.5px solid var(--line);
  font-size: calc(var(--ui-font-size) - 3px);
}
.ch-sync-pill { border-color: var(--line); }
.ch-diff-pill {
  border-color: color-mix(in srgb, var(--color-success) 20%, var(--line));
  font-variant-numeric: tabular-nums;
}
.ch-ahead { color: var(--color-warning); flex: none; }
.ch-behind { color: var(--color-accent-hover); flex: none; }
.ch-add { color: var(--color-success); flex: none; }
.ch-del { color: var(--color-danger); flex: none; }
.ch-spacer { flex: 1; min-width: 0; }

@container (max-width: 720px) {
  .ch-ws,
  .ch-sep { display: none; }
  .ch-id { flex: 1; max-width: none; }
  .ch-spacer { flex: 0; }
}

/* Overflow "…" trigger — IconButton (md). The "open" state keeps the
   sunken highlight while the menu is showing. */
.chat-header .ch-act-more { width: 24px; height: 24px; border-radius: var(--radius-sm); }
.chat-header .ch-act-more :deep(svg) { width: 14px; height: 14px; }
.ch-act-more.open { background: var(--color-well); color: var(--color-text); }

/* Terminal panel toggle — same icon-button geometry as the kebab; the
   "open" state mirrors the panel's visibility. */
.chat-header .ch-terminal { width: var(--space-6); height: var(--space-6); border-radius: var(--radius-sm); }
.chat-header .ch-terminal :deep(svg) { width: var(--p-ic-sm); height: var(--p-ic-sm); }
.ch-terminal.open { background: var(--color-well); color: var(--color-text); }

/* Dev-environment badge — same pill language as the PR badge, in the warning
   hue so a dev window is recognizable at a glance. Not interactive. */
.ch-dev {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 9px;
  flex: none;
  border: 0.5px solid var(--color-warning-bd);
  border-radius: var(--radius-full);
  background: var(--color-warning-soft);
  color: var(--color-warning);
  font-size: var(--text-xs);
  font-weight: 500;
}

/* GitHub PR badge — semantic state colors aligned with GitHub
   (open=green, merged=purple, closed=red, draft=gray). */
.ch-pr {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 9px;
  flex: none;
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-well);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
}
.ch-pr svg { flex: none; }
.ch-pr.pr-open { color: var(--color-success); border-color: var(--color-success-bd); background: var(--color-success-soft); }
.ch-pr.pr-merged { color: var(--color-done); border-color: var(--color-done-bd); background: var(--color-done-soft); }
.ch-pr.pr-closed { color: var(--color-danger); border-color: var(--color-danger-bd); background: var(--color-danger-soft); }
.ch-pr.pr-draft { color: var(--color-text-muted); border-color: var(--color-line-strong); background: var(--color-well); }
.ch-pr.pr-unknown { color: var(--color-text-muted); border-color: var(--color-line-strong); background: var(--color-well); }
.ch-pr:hover { border-color: var(--color-line-strong); }
/* The Done state pill is display-only (no click). */
.ch-done-pill { cursor: default; }
.ch-done-pill:hover { border-color: var(--color-done-bd); }

/* Fixed more-menu, anchored to the kebab trigger. Surface / items come from
   the Menu + MenuItem primitives; only positioning stays here. */
.ch-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}
/* Menu enter/exit — pops out of the trigger corner (the composer model
   dropdown's language): fade + a slight scale, exit a touch faster. The
   origin and the nudge direction come from the positioning code. */
.menu-pop-enter-active {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.menu-pop-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
  /* The leaving menu lingers for --duration-fast; keep it inert so a second
     click can't hit items whose backing state is already torn down. */
  pointer-events: none;
}
.menu-pop-enter-from,
.menu-pop-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(var(--menu-pop-shift, -2px));
}

/* On a narrow conversation column, the action labels collapse to icons. */
@media (max-width: 980px) {
  .ch-act-label { display: none; }
}
@media (max-width: 640px) {
  .chat-header { display: none; }
}
</style>
