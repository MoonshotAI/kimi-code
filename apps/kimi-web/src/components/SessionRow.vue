<!-- apps/kimi-web/src/components/SessionRow.vue -->
<!-- A single session row: status dot + title + time + attention pill + kebab. -->
<!-- Inline rename (dblclick) and delete-confirm live here. -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session } from '../types';
import { copyTextToClipboard } from '../lib/clipboard';
import Spinner from './ui/Spinner.vue';
import Badge from './ui/Badge.vue';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import IconButton from './ui/IconButton.vue';
import Menu from './ui/Menu.vue';
import MenuItem from './ui/MenuItem.vue';
import Icon from './ui/Icon.vue';
import Tooltip from './ui/Tooltip.vue';

const { t } = useI18n();
const { confirm } = useConfirmDialog();

const props = withDefaults(
  defineProps<{
    session: Session;
    active: boolean;
    /** Pending permission requests waiting for the user's approval. */
    approvalCount?: number;
    /** Pending askUserQuestion prompts waiting for the user's answer. */
    questionCount?: number;
    /** A background turn finished here that the user hasn't opened — blue dot. */
    unread?: boolean;
  }>(),
  { approvalCount: 0, questionCount: 0, unread: false },
);

const emit = defineEmits<{
  select: [id: string];
  rename: [id: string, title: string];
  archive: [id: string];
  fork: [id: string];
}>();

// Full, absolute timestamp shown on hover (the row's `time` is a short relative
// string like "2h"/"1d" — see formatTime in useKimiWebClient).
function formatFullTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fullTime = computed(() =>
  props.session.updatedAt ? formatFullTime(props.session.updatedAt) : props.session.time,
);

// Kebab menu
const menuOpen = ref(false);
const kebabRef = ref<InstanceType<typeof IconButton> | null>(null);
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
// Fixed-position style for the teleported kebab menu, anchored to the ⋯ button.
const menuStyle = ref<Record<string, string>>({});

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.el?.contains(target) || kebabRef.value?.el?.contains(target)) return;
  closeMenu();
}

// Anchor the menu to the ⋯ button with a viewport flip (open upward when there
// isn't room below), mirroring the workspace kebab menu in Sidebar.vue. The menu
// is rendered through a body teleport so ancestor `overflow: hidden` (notably the
// collapsing `.group-sessions` list) can't clip it.
function positionMenu(): void {
  const btn = kebabRef.value?.el;
  if (!btn) return;
  const menu = menuRef.value?.el;
  const r = btn.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuH = menu?.offsetHeight ?? 0;
  const menuW = menu?.offsetWidth ?? 0;
  let top = r.bottom + gap;
  if (top + menuH > window.innerHeight - margin) {
    top = Math.max(margin, r.top - menuH - gap);
  }
  let left = r.right - menuW;
  if (left < margin) left = margin;
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  };
}

async function toggleMenu(e: Event): Promise<void> {
  e.stopPropagation();
  if (menuOpen.value) {
    closeMenu();
    return;
  }
  menuOpen.value = true;
  // Defer so the current click doesn't immediately close the menu.
  setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
  window.addEventListener('resize', closeMenu);
  // Wait for the teleported menu to mount so its size can be measured.
  await nextTick();
  positionMenu();
}
function closeMenu(): void {
  menuOpen.value = false;
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('resize', closeMenu);
}

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('resize', closeMenu);
});

// Inline rename
const renaming = ref(false);
const renameValue = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);
async function startRename(): Promise<void> {
  closeMenu();
  renaming.value = true;
  renameValue.value = props.session.title;
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
  if (newTitle) emit('rename', props.session.id, newTitle);
  renaming.value = false;
}
function cancelRename(): void {
  renaming.value = false;
}

// Copy session ID
const copiedId = ref(false);
const copyFailed = ref(false);
async function copySessionId(): Promise<void> {
  const ok = await copyTextToClipboard(props.session.id);
  copiedId.value = ok;
  copyFailed.value = !ok;
  // Keep the menu open briefly so the result text is visible, then close.
  setTimeout(() => {
    copiedId.value = false;
    copyFailed.value = false;
    closeMenu();
  }, 1500);
}

// Fork this session into a new child session
function forkRow(): void {
  closeMenu();
  emit('fork', props.session.id);
}

// Archive confirm — modal, consistent with remove-workspace.
async function startArchive(): Promise<void> {
  closeMenu();
  if (
    await confirm({
      title: t('sidebar.archive'),
      message: t('sidebar.archiveConfirm'),
      variant: 'danger',
    })
  ) {
    emit('archive', props.session.id);
  }
}

// Expose closeMenu so the parent can close on outside-click.
defineExpose({ closeMenu });
</script>

<template>
  <div class="se" :class="{ on: active }" @click="emit('select', session.id)">
    <div class="row">
      <!-- Leading status slot (in the gutter left of the title): a spinner
           while the session runs, otherwise an unread blue dot. Fixed width
           so the title start never shifts. -->
      <span class="lead" aria-hidden="true">
        <Spinner v-if="session.busy" size="sm" />
        <span v-else-if="unread" class="unread-dot" />
      </span>

      <div class="left">
        <!-- Inline rename input -->
        <input
          v-if="renaming"
          ref="renameInputRef"
          v-model="renameValue"
          class="rename-input"
          @click.stop
          @keydown.enter.stop="commitRename"
          @keydown.esc.stop="cancelRename"
          @blur="commitRename"
        />
        <span v-else class="t" @dblclick.stop="startRename">{{ session.title }}</span>
      </div>

      <span class="ts">{{ session.time }}</span>

      <!-- Pending tags — coloured per kind, shown even when the row isn't
           active. "Answer" = an askUserQuestion is waiting; "Approve" = a
           permission request is waiting. The session's lifecycle status drives
           the same tags as a fallback for background sessions whose pending
           lists aren't loaded yet (status known, counts not). -->
      <Tooltip :text="t('workspace.awaitingAnswerTitle')">
        <Badge
          v-if="!renaming && (questionCount > 0 || session.status === 'awaitingQuestion')"
          variant="info"
          size="sm"
        >
          {{ t('workspace.awaitingAnswer') }}
        </Badge>
      </Tooltip>
      <Tooltip :text="t('workspace.awaitingPermissionTitle')">
        <Badge
          v-if="!renaming && (approvalCount > 0 || session.status === 'awaitingApproval')"
          variant="warning"
          size="sm"
        >
          {{ t('workspace.awaitingPermission') }}
        </Badge>
      </Tooltip>
      <!-- Aborted: a distinct, low-key error tag (not collapsed into idle). -->
      <Tooltip :text="t('workspace.abortedTitle')">
        <Badge
          v-if="!renaming && session.status === 'aborted'"
          variant="danger"
          size="sm"
        >
          {{ t('workspace.aborted') }}
        </Badge>
      </Tooltip>

      <!-- Kebab button (visible on hover) -->
      <IconButton
        ref="kebabRef"
        v-if="!renaming"
        class="kebab"
        :class="{ open: menuOpen }"
        size="sm"
        :label="t('sidebar.options')"
        @click.stop="toggleMenu($event)"
      >
        <Icon name="dots-horizontal" size="sm" />
      </IconButton>
    </div>

    <!-- Kebab dropdown — teleported to <body> and position:fixed so it escapes
         the `overflow: hidden` on the collapsing `.group-sessions` list. -->
    <Teleport to="body">
      <Menu ref="menuRef" v-if="menuOpen" class="menu" :style="menuStyle" @click.stop>
        <MenuItem :danger="copyFailed" @click="copySessionId">
          {{
            copyFailed
              ? t('sidebar.copyFailed')
              : copiedId
                ? t('sidebar.copied')
                : t('sidebar.copySessionId')
          }}
        </MenuItem>
        <MenuItem separator />
        <MenuItem @click="startRename">{{ t('sidebar.rename') }}</MenuItem>
        <MenuItem @click="forkRow">{{ t('sidebar.fork') }}</MenuItem>
        <MenuItem danger @click="startArchive">{{ t('sidebar.archive') }}</MenuItem>
        <MenuItem separator />
        <div class="menu-time">{{ fullTime }}</div>
      </Menu>
    </Teleport>
  </div>
</template>

<style scoped>
.se {
  /* --sb-* vars come from .side in Sidebar.vue: the title starts at
     --sb-pad-x + --sb-gutter + --sb-gap, exactly under the workspace name.
     The row is an inset pill: a 6px horizontal margin + 10px padding lands the
     leading icon at --sb-pad-x (16px), aligned with the workspace header. */
  display: block;
  margin: 0;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-md);
  font-family: var(--font-ui);
  color: var(--color-text);
  cursor: pointer;
  position: relative;
}
.se:hover { background: var(--color-surface-sunken); color: var(--color-text); }
.se.on {
  background: var(--color-accent-soft);
  color: var(--color-accent-hover);
  box-shadow: inset 0 0 0 1px var(--color-accent-bd);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--sb-gap, 6px);
  min-width: 0;
  /* Floor the row at the hover-kebab height (IconButton sm = 26px) so swapping
     the timestamp for the kebab on hover doesn't grow the row. */
  min-height: 26px;
}

.left {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}

/* Leading status slot — mirrors the workspace header's icon slot (so the title
   aligns under the workspace name) AND carries the running spinner / unread dot.
   Fixed width keeps the title start fixed whether or not an indicator shows. */
.lead {
  width: var(--sb-gutter, 16px);
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.unread-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
}

.t {
  color: inherit;
  font-size: 15px;
  font-weight: var(--weight-regular);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ts {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  flex: none;
}
.se:hover .ts { display: none; }

/* Kebab button — hidden until hover. Sits at the RIGHT of the timestamp
   and attention badge so it is the right-most element. `.se .kebab` out-
   specificities IconButton's display so the hidden default actually wins. */
.se .kebab { display: none; }
.se:hover .kebab,
.kebab.open { display: inline-flex; }
.kebab.open { color: var(--color-text); background: var(--color-surface-sunken); }

/* Fixed + anchored to the ⋯ button via inline style (see positionMenu); the menu
   is teleported to <body> so the collapsing list's `overflow: hidden` can't clip it. */
.menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}
.menu-time {
  padding: 6px 10px;
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  cursor: default;
  user-select: text;
}

.rename-input {
  flex: 1;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text);
  background: var(--color-bg);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-xs);
  padding: 1px 4px;
  outline: none;
  min-width: 0;
}

.sessions .se {
  margin: 0;
  border-radius: var(--radius-md);
  /* Trim the row padding by the inset margin so the title still starts at the
     same x as the workspace name (whose header has no inset). */
  padding: var(--space-1) calc(var(--sb-pad-x, 12px) - var(--space-2));
}
.sessions .se:hover { background: var(--panel2); }
.sessions .se.on {
  background: var(--color-accent-soft);
  box-shadow: inset 0 0 0 1px var(--color-accent-bd);
}
.sessions .se .rename-input { border-radius: var(--radius-sm); font-family: var(--sans); }
.sessions .se .kebab { border-radius: var(--radius-sm); }
</style>
