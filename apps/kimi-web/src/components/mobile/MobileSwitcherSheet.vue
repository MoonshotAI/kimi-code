<!-- apps/kimi-web/src/components/mobile/MobileSwitcherSheet.vue -->
<!-- Mobile switcher bottom sheet, mirroring the desktop sidebar: a "+ New
     chat" row, then collapsible workspace groups (folder icon + name +
     path sub-line + per-group "+") with their session rows beneath.
     Tapping a session selects it AND closes the sheet; tapping a group header
     folds it, same as the desktop sidebar. -->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session, WorkspaceGroup, WorkspaceView } from '../../types';
import { copyTextToClipboard } from '../../lib/clipboard';
import BottomSheet from '../dialogs/BottomSheet.vue';
import IconButton from '../ui/IconButton.vue';
import Icon from '../ui/Icon.vue';
import Menu from '../ui/Menu.vue';
import MenuItem from '../ui/MenuItem.vue';
import Tooltip from '../ui/Tooltip.vue';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** Workspace groups (same list the desktop sidebar renders). */
    groups: WorkspaceGroup[];
    activeWorkspaceId: string | null;
    activeId: string;
    attentionBySession?: Record<string, number>;
    attentionByWorkspace?: Record<string, number>;
  }>(),
  {
    activeWorkspaceId: null,
    attentionBySession: () => ({}),
    attentionByWorkspace: () => ({}),
  },
);

const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  select: [sessionId: string];
  create: [];
  createInWorkspace: [workspaceId: string];
  addWorkspace: [];
  rename: [id: string, title: string];
  archive: [id: string];
  /** NOTE: App.vue wires this to confirmDeleteWorkspace (modal confirm + async delete). */
  deleteWorkspace: [workspaceId: string];
  loadMore: [workspaceId: string];
}>();

function close(): void {
  emit('update:modelValue', false);
}

function onSelectSession(id: string): void {
  emit('select', id);
  close();
}

function onCreateInWorkspace(id: string): void {
  emit('createInWorkspace', id);
  close();
}

function onCreate(): void {
  emit('create');
  close();
}

function onAddWorkspace(): void {
  emit('addWorkspace');
  close();
}

// ---------------------------------------------------------------------------
// Collapse groups — same interaction as the desktop sidebar header.
// ---------------------------------------------------------------------------
const collapsedIds = ref<Set<string>>(new Set());

function isCollapsed(id: string): boolean {
  return collapsedIds.value.has(id);
}

function toggleCollapse(id: string): void {
  const next = new Set(collapsedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedIds.value = next;
  // Tapping a header also dismisses any open row/workspace menu.
  menuFor.value = null;
  wsMenuFor.value = null;
}

// ---------------------------------------------------------------------------
// In-group expand / collapse (show-more pagination) — mirrors the desktop
// sidebar. Local to the sheet; a refresh reloads only the first page.
// ---------------------------------------------------------------------------
const expandedIds = ref<Set<string>>(new Set());

function isExpanded(id: string): boolean {
  return expandedIds.value.has(id);
}

function toggleExpand(id: string): void {
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIds.value = next;
}

function visibleSessions(g: WorkspaceGroup): Session[] {
  if (isExpanded(g.workspace.id)) return g.sessions;
  const head = g.sessions.slice(0, g.initialCount);
  // Keep the active session visible when it's beyond the first page (e.g.
  // selected via search or a deep link), mirroring the desktop sidebar.
  if (props.activeId && !head.some((s) => s.id === props.activeId)) {
    const active = g.sessions.find((s) => s.id === props.activeId);
    if (active) return [...head, active];
  }
  return head;
}

function onLoadMore(id: string): void {
  // Loading more should reveal the new rows immediately.
  if (!expandedIds.value.has(id)) {
    const next = new Set(expandedIds.value);
    next.add(id);
    expandedIds.value = next;
  }
  emit('loadMore', id);
}

function wsAttention(id: string): number {
  return props.attentionByWorkspace[id] ?? 0;
}

// ---------------------------------------------------------------------------
// Per-row kebab menu (rename / archive) — opened from the ⋯ button.
// Archive is confirmed via modal (consistent with remove-workspace).
// ---------------------------------------------------------------------------
const menuFor = ref<string | null>(null);

function toggleMenu(id: string): void {
  menuFor.value = menuFor.value === id ? null : id;
  wsMenuFor.value = null;
}
function onRename(s: Session): void {
  menuFor.value = null;
  const next = typeof window !== 'undefined' ? window.prompt(t('sidebar.rename'), s.title) : null;
  const title = next?.trim();
  if (title) emit('rename', s.id, title);
}
function onArchive(id: string): void {
  menuFor.value = null;
  // The modal confirm + async archive live in App.vue (confirmArchiveSession).
  emit('archive', id);
}

// ---------------------------------------------------------------------------
// Per-workspace "…" menu: copy path + delete workspace. Copy path is handled
// locally, like the desktop sidebar; delete is emitted to the parent (App.vue
// owns the modal confirm + async delete).
// ---------------------------------------------------------------------------
const wsMenuFor = ref<string | null>(null);

function toggleWsMenu(id: string): void {
  wsMenuFor.value = wsMenuFor.value === id ? null : id;
  menuFor.value = null;
}
function onCopyWsPath(ws: WorkspaceView): void {
  void copyTextToClipboard(ws.root);
  wsMenuFor.value = null;
}
function onDeleteWorkspace(ws: WorkspaceView): void {
  wsMenuFor.value = null;
  emit('deleteWorkspace', ws.id);
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- + New chat (mirrors the sidebar's top button) -->
    <button type="button" class="newrow" @click="onCreate">
      <Icon name="message" size="sm" />
      {{ t('sidebar.newChat') }}
    </button>
    <button type="button" class="newrow secondary" @click="onAddWorkspace">
      <Icon name="folder" size="sm" />
      {{ t('sidebar.newWorkspace') }}
    </button>

    <!-- Workspace groups with their sessions -->
    <div class="mlist">
      <div v-if="groups.length === 0" class="mempty">
        {{ t('workspace.noWorkspace') }}
      </div>

      <div v-for="g in groups" :key="g.workspace.id" class="mgroup">
        <div
          class="mgh"
          :class="{ on: g.workspace.id === activeWorkspaceId }"
          @click="toggleCollapse(g.workspace.id)"
        >
          <!-- Folder icon: open/closed mirrors the desktop sidebar -->
          <Icon v-if="isCollapsed(g.workspace.id)" class="mgh-folder" name="folder-closed" size="sm" />
          <Icon v-else class="mgh-folder" name="folder" size="sm" />

          <div class="mgh-main">
            <span class="mgh-name">{{ g.workspace.name }}</span>
            <Tooltip :text="g.workspace.root">
              <span class="mgh-path">{{ g.workspace.shortPath }}</span>
            </Tooltip>
          </div>

          <span
            v-if="isCollapsed(g.workspace.id) && wsAttention(g.workspace.id) > 0"
            class="att"
          >{{ wsAttention(g.workspace.id) }}</span>

          <IconButton
            size="lg"
            class="mgh-more"
            :label="t('sidebar.options')"
            @click.stop="toggleWsMenu(g.workspace.id)"
          >
            <Icon name="dots-horizontal" size="md" />
          </IconButton>

          <IconButton
            size="lg"
            class="mgh-add"
            :label="t('workspace.newInGroup')"
            @click.stop="onCreateInWorkspace(g.workspace.id)"
          >
            <Icon name="plus" size="md" />
          </IconButton>

          <!-- Workspace menu: copy path / delete (two-step confirm) -->
          <Menu v-if="wsMenuFor === g.workspace.id" class="kmenu wsmenu" @click.stop>
            <MenuItem size="lg" @click="onCopyWsPath(g.workspace)">
              {{ t('sidebar.copyPath') }}
            </MenuItem>
            <MenuItem size="lg" danger @click="onDeleteWorkspace(g.workspace)">{{ t('sidebar.delete') }}</MenuItem>
          </Menu>
        </div>

        <div v-show="!isCollapsed(g.workspace.id)">
          <div v-if="g.sessions.length === 0" class="mempty small">{{ t('sidebar.noSessions') }}</div>
          <div
            v-for="s in visibleSessions(g)"
            :key="s.id"
            class="srow"
            :class="{ cur: s.id === activeId }"
            @click="onSelectSession(s.id)"
          >
            <div class="m">
              <div class="t" :class="{ run: s.busy, aborted: !s.busy && (attentionBySession[s.id] ?? 0) === 0 && (s.lastTurnReason === 'cancelled' || s.lastTurnReason === 'failed') }">{{ s.title }}</div>
              <div class="s">{{ s.time }}</div>
            </div>
            <span v-if="(attentionBySession[s.id] ?? 0) > 0" class="att">{{ attentionBySession[s.id] }}</span>
            <IconButton
              size="lg"
              class="kb"
              :label="t('sidebar.options')"
              @click.stop="toggleMenu(s.id)"
            >
              <Icon name="dots-horizontal" size="md" />
            </IconButton>

            <!-- Kebab menu -->
            <Menu v-if="menuFor === s.id" class="kmenu" @click.stop>
              <MenuItem size="lg" @click="onRename(s)">{{ t('sidebar.rename') }}</MenuItem>
              <MenuItem size="lg" danger @click="onArchive(s.id)">{{ t('sidebar.archive') }}</MenuItem>
            </Menu>
          </div>
          <button
            v-if="g.hasMore || g.loadingMore"
            type="button"
            class="mshow-more"
            :disabled="g.loadingMore"
            @click.stop="onLoadMore(g.workspace.id)"
          >
            {{
              g.loadingMore
                ? t('sidebar.loadingMore')
                : t('sidebar.showMore', { count: Math.max(0, g.workspace.sessionCount - g.sessions.length) })
            }}
          </button>
          <button
            v-if="g.sessions.length > g.initialCount"
            type="button"
            class="mshow-more"
            @click.stop="toggleExpand(g.workspace.id)"
          >
            {{
              isExpanded(g.workspace.id)
                ? t('sidebar.showLess')
                : t('sidebar.showAll', { count: g.sessions.length - g.initialCount })
            }}
          </button>
        </div>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
/* ---- + New chat / workspace rows ---- */
.newrow {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: var(--space-3) var(--space-4);
  background: none;
  border: none;
  border-radius: var(--radius-md);
  color: var(--color-accent);
  font-weight: 500;
  font-size: var(--text-base);
  cursor: pointer;
  text-align: left;
}
.newrow:hover { background: var(--color-surface-sunken); }
.newrow:active { background: var(--color-surface-sunken); }
.newrow.secondary {
  padding-top: var(--space-2);
  padding-bottom: var(--space-2);
  color: var(--color-text-muted);
  font-weight: 400;
}
.newrow.secondary:hover { background: var(--color-surface-sunken); }
.newrow.secondary:active { background: var(--color-surface-sunken); color: var(--color-text); }

/* ---- List + alignment contract (mirrors the desktop sidebar):
        session titles start at --m-pad + --m-gutter + --m-gap, exactly under
        the workspace name next to the folder icon. ---- */
.mlist {
  --m-pad: 16px;    /* row horizontal padding */
  --m-gutter: 15px; /* folder icon width */
  --m-gap: 8px;     /* gap between icon and text */
  --m-indent: calc(var(--m-pad) + var(--m-gutter) + var(--m-gap));
  padding-bottom: var(--space-1);
}
.mempty {
  padding: var(--space-6) var(--space-4);
  text-align: center;
  color: var(--color-text-faint);
  font-size: var(--ui-font-size);
}
.mempty.small { padding: 10px 16px 12px var(--m-indent); text-align: left; font-size: var(--ui-font-size-xs); }

/* ---- Workspace group header ---- */
.mgroup { padding-top: 2px; }
.mgh {
  display: flex;
  align-items: center;
  gap: var(--m-gap);
  padding: 10px var(--m-pad) 6px;
  border-radius: var(--radius-md);
  cursor: pointer;
  user-select: none;
  position: relative; /* anchors the workspace "…" menu */
}
.mgh:hover { background: var(--color-surface-sunken); }
.mgh:active { background: var(--color-surface-sunken); }
.mgh-folder { flex: none; color: var(--color-text-muted); }
.mgh-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.mgh-name {
  font-size: var(--ui-font-size-lg);
  font-weight: 550;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgh-path {
  font-size: var(--text-base);
  font-weight: 425;
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgh-add { margin: -10px -12px -10px 0; }
.mgh-add:active { color: var(--color-text); background: var(--color-surface-sunken); }

/* Workspace "…" menu trigger */
.mgh-more { margin: -10px -8px; }
.mgh-more:active { color: var(--color-text); background: var(--color-surface-sunken); }

/* ---- Session rows ---- */
.srow {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--m-pad) var(--space-3) var(--m-indent);
  border-radius: var(--radius-md);
  cursor: pointer;
  position: relative;
}
.srow:hover { background: var(--color-surface-sunken); }
.srow:active { background: var(--color-surface-sunken); }
.srow.cur { background: var(--color-accent-soft); box-shadow: inset 0 0 0 1px var(--color-accent-bd); }
.srow .m { flex: 1; min-width: 0; }
.srow .m .t {
  font-size: var(--text-base);
  font-weight: 450;
  line-height: var(--leading-tight);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srow.cur .m .t { color: var(--color-accent-hover); }

/* Running indicator — pulse dot in the indent gutter left of the title,
   mirroring the desktop SessionRow (.t.run::before). */
.srow .m .t.run { position: relative; }
.srow .m .t.run::before {
  content: '';
  position: absolute;
  left: -14px;
  top: 50%;
  transform: translateY(-50%);
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  animation: mRunPulse 1.4s ease-in-out infinite;
}
@keyframes mRunPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
/* Aborted: a static red dot in the same gutter slot (no pulse — it's finished). */
.srow .m .t.aborted { position: relative; }
.srow .m .t.aborted::before {
  content: '';
  position: absolute;
  left: -14px;
  top: 50%;
  transform: translateY(-50%);
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-danger);
}
.srow .m .s {
  font-size: var(--text-base);
  font-weight: 475;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-faint);
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.att {
  flex: none;
  font-family: var(--font-mono);
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  color: var(--color-text-on-accent);
  background: var(--color-warning);
  border-radius: var(--radius-full);
  padding: 1px 7px;
}
.srow .kb:active { color: var(--color-text); background: var(--color-surface-sunken); }

/* Kebab menu — surface from Menu primitive; only positioning here. */
.kmenu {
  position: absolute;
  right: 12px;
  top: 44px;
  z-index: var(--z-dropdown);
  min-width: 96px;
  overflow: hidden;
}

/* Workspace "…" menu — anchored to the group header. */
.wsmenu {
  top: calc(100% - 4px);
  right: var(--m-pad);
  min-width: 132px;
}

/* "Show more" — same indent as session rows, 44px tap target */
.mshow-more {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 44px;
  padding: var(--space-1) var(--m-pad) var(--space-1) var(--m-indent);
  background: none;
  border: none;
  color: var(--color-text-muted);
  font-size: var(--text-base);
  cursor: pointer;
  text-align: left;
}
.mshow-more:active { color: var(--color-accent-hover); background: var(--color-surface-sunken); }

.newrow { font-family: var(--sans); }
.mlist .srow {
  margin: 1px 8px;
  border-radius: var(--radius-md);
  border-bottom: none;
  /* Trim both paddings by the 8px inset margin so session titles stay on the
     sheet's --m-indent alignment line (under the workspace name). */
  padding: 12px calc(var(--m-pad, 16px) - 8px) 12px calc(var(--m-indent, 39px) - 8px);
}
.mlist .srow.cur { box-shadow: inset 0 0 0 1px var(--color-accent-bd); }
</style>
