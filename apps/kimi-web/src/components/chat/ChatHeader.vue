<!-- apps/kimi-web/src/components/chat/ChatHeader.vue -->
<!-- Thin context bar above the chat: workspace / session name, git branch +
     status, "open in editor", and a ⋮ more-menu that bundles copy-all plus
     the same session actions available from the sidebar session row. -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import { isMacosDesktop } from '../../lib/desktopFlag';
import Menu from '../ui/Menu.vue';
import MenuItem from '../ui/MenuItem.vue';
import IconButton from '../ui/IconButton.vue';
import Icon from '../ui/Icon.vue';
import Tooltip from '../ui/Tooltip.vue';
import { useConfirmDialog } from '../../composables/useConfirmDialog';

const { t } = useI18n();
const { confirm } = useConfirmDialog();

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
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('resize', onScrollOrResize);
}

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocClick);
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
// Archive — modal confirm (the header has no session row to swap, so use the
// shared ConfirmDialog instead of the inline strip used in SessionRow).
// ---------------------------------------------------------------------------
async function startArchive(): Promise<void> {
  if (!props.sessionId) return;
  closeMenu();
  if (
    await confirm({
      title: t('header.archiveSession'),
      message: t('sidebar.archiveConfirm'),
      variant: 'danger',
    })
  ) {
    emit('archiveSession', props.sessionId);
  }
}
</script>

<template>
  <header class="chat-header" :class="{ 'macos-desktop': isMacosDesktop }">
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
      <Tooltip v-else-if="sessionTitle" :text="sessionTitle">
        <span class="ch-ses">{{ sessionTitle }}</span>
      </Tooltip>
    </div>

    <!-- More menu trigger: copy-all + session actions -->
    <Tooltip :text="t('header.options')">
      <IconButton
        ref="kebabRef"
        class="ch-act-more"
        :class="{ open: menuOpen }"
        :label="t('header.options')"
        :aria-expanded="menuOpen"
        aria-haspopup="menu"
        @click.stop="toggleMenu($event)"
      >
        <Icon name="dots-horizontal" size="md" />
      </IconButton>
    </Tooltip>

    <!-- Fixed more menu -->
    <Menu
      v-if="menuOpen"
      ref="menuRef"
      class="ch-menu"
      :style="menuStyle"
      @click.stop
    >
      <MenuItem @click="onCopyAll">
        {{ copied ? t('header.copied') : t('header.copyAll') }}
      </MenuItem>
      <MenuItem @click="onCopyFinalSummary">
        {{ t('header.copyFinalSummary') }}
      </MenuItem>
      <template v-if="sessionId">
        <MenuItem separator />
        <MenuItem @click="copySessionId">
          {{ copiedId ? t('header.copied') : t('header.copySessionId') }}
        </MenuItem>
        <MenuItem @click="startRename">
          {{ t('header.renameSession') }}
        </MenuItem>
        <MenuItem @click="forkSession">
          {{ t('header.forkSession') }}
        </MenuItem>
        <MenuItem danger @click="startArchive">{{ t('header.archiveSession') }}</MenuItem>
      </template>
    </Menu>

    <div class="ch-spacer" />

    <!-- Git branch + status — plain text with semantic colors. Renders for any
         git repo, even a detached HEAD (empty branch → "detached" label), so the
         diff counter below is never hidden just because there's no branch name. -->
    <Tooltip :text="t('header.gitTooltip')">
      <button
        v-if="isGitRepo"
        type="button"
        class="ch-git"
        @click="emit('openChanges')"
      >
        <Tooltip :text="branch || t('header.detached')">
          <span
            class="ch-branch"
            :class="{ 'ch-detached': !branch }"
          >
            {{ branch || t('header.detached') }}
          </span>
        </Tooltip>
        <span v-if="ahead > 0 || behind > 0" class="ch-pill ch-sync-pill">
          <span v-if="ahead > 0" class="ch-ahead">↑{{ ahead }}</span>
          <span v-if="behind > 0" class="ch-behind">↓{{ behind }}</span>
        </span>
        <span v-if="hasLineStats" class="ch-pill ch-diff-pill">
          <span v-if="adds > 0" class="ch-add">+{{ adds }}</span>
          <span v-if="dels > 0" class="ch-del">-{{ dels }}</span>
        </span>
      </button>
    </Tooltip>

    <!-- GitHub PR status -->
    <Tooltip :text="t('header.openPr')">
      <button
        v-if="pr"
        type="button"
        class="ch-pill ch-pr"
        :class="`pr-${pr.state}`"
        @click="pr && emit('openPr', pr.url)"
      >
        <Icon name="git-pull-request" size="sm" />
        <span>PR #{{ pr.number }} · {{ pr.state }}</span>
      </button>
    </Tooltip>

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
  border-bottom: 1px solid var(--color-line);
  background: var(--color-bg);
  font-family: var(--font-ui);
  min-width: 0;
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
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-xs);
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
.ch-git:hover .ch-branch { color: var(--color-text); }
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
.ch-diff-pill { border-color: color-mix(in srgb, var(--color-success) 20%, var(--line)); }
.ch-ahead { color: var(--color-warning); flex: none; }
.ch-behind { color: var(--color-accent-hover); flex: none; }
.ch-add { color: var(--color-success); flex: none; }
.ch-del { color: var(--color-danger); flex: none; }
.ch-spacer { flex: 1; min-width: 0; }

/* Overflow "…" trigger — IconButton (md). The "open" state keeps the
   sunken highlight while the menu is showing. */
.ch-act-more.open { background: var(--color-surface-sunken); color: var(--color-text); }

/* GitHub PR badge — semantic state colors aligned with GitHub
   (open=green, merged=purple, closed=red, draft=gray). */
.ch-pr {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 9px;
  flex: none;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-weight: 500;
  cursor: pointer;
}
.ch-pr svg { flex: none; }
.ch-pr.pr-open { color: var(--color-success); border-color: var(--color-success-bd); background: var(--color-success-soft); }
.ch-pr.pr-merged { color: var(--color-done); border-color: var(--color-done-bd); background: var(--color-done-soft); }
.ch-pr.pr-closed { color: var(--color-danger); border-color: var(--color-danger-bd); background: var(--color-danger-soft); }
.ch-pr.pr-draft { color: var(--color-text-muted); border-color: var(--color-line-strong); background: var(--color-surface-sunken); }
.ch-pr:hover { border-color: var(--color-line-strong); }

/* Fixed more-menu, anchored to the kebab trigger. Surface / items come from
   the Menu + MenuItem primitives; only positioning stays here. */
.ch-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}

/* On a narrow conversation column, the action labels collapse to icons. */
@media (max-width: 980px) {
  .ch-act-label { display: none; }
}
@media (max-width: 640px) {
  .chat-header { display: none; }
}
</style>
