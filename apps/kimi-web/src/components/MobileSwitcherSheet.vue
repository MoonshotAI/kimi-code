<!-- apps/kimi-web/src/components/MobileSwitcherSheet.vue -->
<!-- Mobile switcher bottom sheet, mirroring the desktop sidebar: a "+ New
     chat" row, then collapsible workspace groups (folder icon + name +
     branch/path sub-line + per-group "+") with their session rows beneath.
     Tapping a session selects it AND closes the sheet; tapping a group header
     folds it, same as the desktop sidebar. -->
<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session, WorkspaceGroup, WorkspaceView } from '../types';
import BottomSheet from './BottomSheet.vue';

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
  /** NOTE: needs `@delete-workspace="client.deleteWorkspace($event)"` wiring in App.vue. */
  deleteWorkspace: [workspaceId: string];
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
  if (next.has(id)) {
    next.delete(id);
    // Reset session expansion when the workspace is expanded (desktop parity)
    const expandedNext = new Set(expandedWsIds.value);
    expandedNext.delete(id);
    expandedWsIds.value = expandedNext;
  } else {
    next.add(id);
  }
  collapsedIds.value = next;
  // Tapping a header also dismisses any open row/workspace menu.
  menuFor.value = null;
  wsMenuFor.value = null;
}

function wsAttention(id: string): number {
  return props.attentionByWorkspace[id] ?? 0;
}

// ---------------------------------------------------------------------------
// Session list truncation per workspace (desktop sidebar parity):
// default visible = union of (first 5) and (updated within 5 days), and the
// active session is always kept visible.
// ---------------------------------------------------------------------------
const DEFAULT_VISIBLE_COUNT = 5;
const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

/** workspace id → true = show all sessions */
const expandedWsIds = ref<Set<string>>(new Set());

function isExpanded(wsId: string): boolean {
  return expandedWsIds.value.has(wsId);
}

function toggleExpand(wsId: string): void {
  const next = new Set(expandedWsIds.value);
  if (next.has(wsId)) next.delete(wsId);
  else next.add(wsId);
  expandedWsIds.value = next;
}

function visibleSessions(sessions: Session[], expanded: boolean, activeId?: string): Session[] {
  if (expanded || sessions.length <= DEFAULT_VISIBLE_COUNT) return sessions;
  const now = Date.now();
  const cutoff = now - FIVE_DAYS_MS;
  const recent5 = sessions.slice(0, DEFAULT_VISIBLE_COUNT);
  const recent5Ids = new Set(recent5.map((s) => s.id));
  const within5Days = sessions.filter((s) => {
    if (recent5Ids.has(s.id)) return false;
    const ts = s.updatedAt ? Date.parse(s.updatedAt) : 0;
    return ts > cutoff;
  });
  const visible = [...recent5, ...within5Days];
  if (activeId && !visible.some((s) => s.id === activeId)) {
    const active = sessions.find((s) => s.id === activeId);
    if (active) visible.push(active);
  }
  return visible;
}

// ---------------------------------------------------------------------------
// Per-row kebab menu (rename / archive) — opened from the ⋯ button.
// Archiving is two-step: the first tap arms the item ("Archive session?"),
// a second tap within 2.5s confirms; otherwise it reverts.
// ---------------------------------------------------------------------------
const menuFor = ref<string | null>(null);
const confirmingArchiveId = ref<string | null>(null);
let confirmArchiveTimer: ReturnType<typeof setTimeout> | undefined;

function toggleMenu(id: string): void {
  menuFor.value = menuFor.value === id ? null : id;
  wsMenuFor.value = null;
  clearTimeout(confirmArchiveTimer);
  confirmingArchiveId.value = null;
}
function onRename(s: Session): void {
  menuFor.value = null;
  const next = typeof window !== 'undefined' ? window.prompt(t('sidebar.rename'), s.title) : null;
  const title = next?.trim();
  if (title) emit('rename', s.id, title);
}
function onArchive(id: string): void {
  if (confirmingArchiveId.value === id) {
    clearTimeout(confirmArchiveTimer);
    confirmingArchiveId.value = null;
    menuFor.value = null;
    emit('archive', id);
    return;
  }
  clearTimeout(confirmArchiveTimer);
  confirmingArchiveId.value = id;
  confirmArchiveTimer = setTimeout(() => {
    confirmingArchiveId.value = null;
  }, 2500);
}

// ---------------------------------------------------------------------------
// Per-workspace "…" menu: copy path + delete workspace (two-step confirm,
// same 2.5s timeout as sessions). Copy path is handled locally, like the
// desktop sidebar; delete is emitted to the parent.
// ---------------------------------------------------------------------------
const wsMenuFor = ref<string | null>(null);
const confirmingWsDeleteId = ref<string | null>(null);
let confirmWsDeleteTimer: ReturnType<typeof setTimeout> | undefined;

function toggleWsMenu(id: string): void {
  wsMenuFor.value = wsMenuFor.value === id ? null : id;
  menuFor.value = null;
  clearTimeout(confirmWsDeleteTimer);
  confirmingWsDeleteId.value = null;
}
function onCopyWsPath(ws: WorkspaceView): void {
  void navigator.clipboard.writeText(ws.root);
  wsMenuFor.value = null;
}
function onDeleteWorkspace(id: string): void {
  if (confirmingWsDeleteId.value === id) {
    clearTimeout(confirmWsDeleteTimer);
    confirmingWsDeleteId.value = null;
    wsMenuFor.value = null;
    emit('deleteWorkspace', id);
    return;
  }
  clearTimeout(confirmWsDeleteTimer);
  confirmingWsDeleteId.value = id;
  confirmWsDeleteTimer = setTimeout(() => {
    confirmingWsDeleteId.value = null;
  }, 2500);
}

onUnmounted(() => {
  clearTimeout(confirmArchiveTimer);
  clearTimeout(confirmWsDeleteTimer);
});
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- + New chat (mirrors the sidebar's top button) -->
    <button type="button" class="newrow" @click="onCreate">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 2.5h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8.5l-2.5 2V11.5H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z" />
      </svg>
      {{ t('sidebar.newChat') }}
    </button>
    <button type="button" class="newrow secondary" @click="onAddWorkspace">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
        <path d="M1 3.5V2.5A1 1 0 0 1 2 1.5h3.5l1.3 2h5.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"/>
        <path d="M1 5.5h12"/>
      </svg>
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
          <svg
            class="mgh-folder"
            width="15"
            height="15"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            aria-hidden="true"
          >
            <template v-if="isCollapsed(g.workspace.id)">
              <rect x="1" y="3.5" width="12" height="8.5" rx="1"/>
              <path d="M1 5V3.5A1 1 0 0 1 2 2.5h3.5l1.3 2"/>
            </template>
            <template v-else>
              <path d="M1 3.5V2.5A1 1 0 0 1 2 1.5h3.5l1.3 2h5.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"/>
              <path d="M1 5.5h12"/>
            </template>
          </svg>

          <div class="mgh-main">
            <span class="mgh-name">{{ g.workspace.name }}</span>
            <span class="mgh-path" :title="g.workspace.root">{{ g.workspace.branch || g.workspace.shortPath }}</span>
          </div>

          <span
            v-if="isCollapsed(g.workspace.id) && wsAttention(g.workspace.id) > 0"
            class="att"
          >{{ wsAttention(g.workspace.id) }}</span>

          <button
            type="button"
            class="mgh-more"
            :title="t('sidebar.options')"
            :aria-label="t('sidebar.options')"
            @click.stop="toggleWsMenu(g.workspace.id)"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
              <circle cx="8" cy="3" r="1.3" />
              <circle cx="8" cy="8" r="1.3" />
              <circle cx="8" cy="13" r="1.3" />
            </svg>
          </button>

          <button
            type="button"
            class="mgh-add"
            :title="t('workspace.newInGroup')"
            :aria-label="t('workspace.newInGroup')"
            @click.stop="onCreateInWorkspace(g.workspace.id)"
          >+</button>

          <!-- Workspace menu: copy path / delete (two-step confirm) -->
          <div v-if="wsMenuFor === g.workspace.id" class="kmenu wsmenu" @click.stop>
            <button class="kitem" @click.stop="onCopyWsPath(g.workspace)">
              {{ t('sidebar.copyPath') }}
            </button>
            <button class="kitem archive" @click.stop="onDeleteWorkspace(g.workspace.id)">
              {{ confirmingWsDeleteId === g.workspace.id ? t('sidebar.confirm') : t('sidebar.delete') }}
            </button>
          </div>
        </div>

        <div v-show="!isCollapsed(g.workspace.id)">
          <div v-if="g.sessions.length === 0" class="mempty small">{{ t('sidebar.noSessions') }}</div>
          <div
            v-for="s in visibleSessions(g.sessions, isExpanded(g.workspace.id), activeId)"
            :key="s.id"
            class="srow"
            :class="{ cur: s.id === activeId }"
            @click="onSelectSession(s.id)"
          >
            <div class="m">
              <div class="t" :class="{ run: s.busy, aborted: s.status === 'aborted' }">{{ s.title }}</div>
              <div class="s">{{ s.time }}</div>
            </div>
            <span v-if="(attentionBySession[s.id] ?? 0) > 0" class="att">{{ attentionBySession[s.id] }}</span>
            <button
              type="button"
              class="kb"
              :title="t('sidebar.options')"
              @click.stop="toggleMenu(s.id)"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                <circle cx="8" cy="3" r="1.3" />
                <circle cx="8" cy="8" r="1.3" />
                <circle cx="8" cy="13" r="1.3" />
              </svg>
            </button>

            <!-- Kebab menu -->
            <div v-if="menuFor === s.id" class="kmenu" @click.stop>
              <button class="kitem" @click.stop="onRename(s)">{{ t('sidebar.rename') }}</button>
              <button class="kitem archive" @click.stop="onArchive(s.id)">
                {{ confirmingArchiveId === s.id ? t('sidebar.archiveConfirm') : t('sidebar.archive') }}
              </button>
            </div>
          </div>
          <button
            v-if="!isExpanded(g.workspace.id) && visibleSessions(g.sessions, false, activeId).length < g.sessions.length"
            type="button"
            class="mshow-more"
            @click.stop="toggleExpand(g.workspace.id)"
          >
            {{ t('sidebar.showMore', { count: g.sessions.length - visibleSessions(g.sessions, false, activeId).length }) }}
          </button>
        </div>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
/* ---- + New workspace row ---- */
.newrow {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 14px 16px;
  background: none;
  border: none;
  border-bottom: 1px solid var(--line2);
  color: var(--blue);
  font-family: var(--mono);
  font-weight: 600;
  font-size: calc(var(--ui-font-size) - 0.5px);
  cursor: pointer;
  text-align: left;
}
.newrow:active { background: var(--panel); }
.newrow.secondary {
  padding-top: 10px;
  padding-bottom: 10px;
  color: var(--muted);
  font-weight: 400;
  border-bottom: 1px solid var(--line2);
}
.newrow.secondary:active { background: var(--panel); color: var(--dim); }

/* ---- List + alignment contract (mirrors the desktop sidebar):
        session titles start at --m-pad + --m-gutter + --m-gap, exactly under
        the workspace name next to the folder icon. ---- */
.mlist {
  --m-pad: 16px;    /* row horizontal padding */
  --m-gutter: 15px; /* folder icon width */
  --m-gap: 8px;     /* gap between icon and text */
  --m-indent: calc(var(--m-pad) + var(--m-gutter) + var(--m-gap));
  padding-bottom: 4px;
}
.mempty {
  padding: 24px 16px;
  text-align: center;
  color: var(--faint);
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
  cursor: pointer;
  user-select: none;
  position: relative; /* anchors the workspace "…" menu */
}
.mgh:active { background: var(--panel); }
.mgh-folder { flex: none; color: var(--muted); }
.mgh-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.mgh-name {
  font-size: var(--ui-font-size-lg);
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgh-path {
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgh-add {
  flex: none;
  background: transparent;
  border: none;
  color: var(--faint);
  cursor: pointer;
  font-family: var(--mono);
  /* Fixed icon glyph size (+) — not part of the UI font scale. */
  font-size: 20px;
  line-height: 1;
  /* 44px square tap target */
  width: 44px;
  height: 44px;
  margin: -10px -12px -10px 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mgh-add:active { color: var(--dim); }

/* Workspace "…" menu trigger — 44px square tap target like .mgh-add */
.mgh-more {
  flex: none;
  background: transparent;
  border: none;
  color: var(--faint);
  cursor: pointer;
  width: 44px;
  height: 44px;
  margin: -10px -8px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mgh-more:active { color: var(--dim); }

/* ---- Session rows ---- */
.srow {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px var(--m-pad) 13px var(--m-indent);
  border-bottom: 1px solid var(--line2);
  cursor: pointer;
  position: relative;
}
.srow:active { background: var(--panel); }
.srow.cur { background: var(--bluebg); }
.srow .m { flex: 1; min-width: 0; }
.srow .m .t {
  font-size: calc(var(--ui-font-size) - 0.5px);
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srow.cur .m .t { font-weight: 600; color: var(--blue2); }

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
  border-radius: 50%;
  background: var(--blue);
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
  border-radius: 50%;
  background: var(--err);
}
.srow .m .s {
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--faint);
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.att {
  flex: none;
  font-family: var(--mono);
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  color: var(--bg);
  background: var(--warn);
  border-radius: 10px;
  padding: 1px 7px;
}
.srow .kb {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--faint);
  padding: 4px;
}
.srow .kb:active { color: var(--ink); }

/* Kebab menu */
.kmenu {
  position: absolute;
  right: 12px;
  top: 44px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  z-index: 10;
  box-shadow: 0 4px 16px rgba(18, 22, 30, 0.16);
  overflow: hidden;
  min-width: 96px;
}
.kitem {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 1.5px);
  color: var(--ink);
  padding: 10px 14px;
}
.kitem:active { background: var(--panel2); }
.kitem.archive { color: var(--err); }
.kitem.archive:active { background: color-mix(in srgb, var(--err) 10%, transparent); }

/* Workspace "…" menu — anchored to the group header, items ≥44px tall */
.wsmenu {
  top: calc(100% - 4px);
  right: var(--m-pad);
  min-width: 132px;
}
.wsmenu .kitem {
  display: flex;
  align-items: center;
  min-height: 44px;
}

/* "Show more" — same indent as session rows, 44px tap target */
.mshow-more {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 44px;
  padding: 4px var(--m-pad) 4px var(--m-indent);
  background: none;
  border: none;
  border-bottom: 1px solid var(--line2);
  color: var(--dim);
  font-size: calc(var(--ui-font-size) - 1.5px);
  font-family: var(--mono);
  cursor: pointer;
  text-align: left;
}
.mshow-more:active { color: var(--blue2); background: var(--panel); }
</style>
