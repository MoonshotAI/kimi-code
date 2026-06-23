<!-- apps/kimi-web/src/components/Sidebar.vue -->
<!-- Unified sidebar: session groups with collapsible workspace headers.
     The old workspace rail and workspace tabs have been removed;
     workspace switching, folding and renaming all live in the group header. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { serverEndpointLabel } from '../api/config';
import { copyTextToClipboard } from '../lib/clipboard';
import type { Session, WorkspaceGroup as WorkspaceGroupType, WorkspaceView } from '../types';
import SessionRow from './SessionRow.vue';
import WorkspaceGroup from './WorkspaceGroup.vue';

const { t } = useI18n();

// Dev-only affordance: when the page is served by the Vite dev server, the
// logo turns yellow and the backend host:port is appended to the title —
// handy for telling several dev tabs apart. In production this is all inert.
const isDev = import.meta.env.DEV;
const endpoint = isDev ? serverEndpointLabel() : '';

const props = withDefaults(
  defineProps<{
    activeWorkspace: WorkspaceView | null;
    activeWorkspaceId: string | null;
    sessions: Session[];
    groups: WorkspaceGroupType[];
    activeId: string;
    attentionBySession?: Record<string, number>;
    /** Per-session pending counts split by kind, for the coloured tags. */
    pendingBySession?: Record<string, { approvals: number; questions: number }>;
    unreadBySession?: Record<string, boolean>;
    /** Width (px) of the session column, driven by the App resize handle. */
    colWidth?: number;
  }>(),
  {
    activeWorkspace: null,
    activeWorkspaceId: null,
    attentionBySession: () => ({}),
    pendingBySession: () => ({}),
    unreadBySession: () => ({}),
    colWidth: 220,
  },
);

const emit = defineEmits<{
  select: [sessionId: string];
  create: [];
  createInWorkspace: [workspaceId: string];
  selectWorkspace: [workspaceId: string];
  selectWorkspaces: [ids: string[]];
  addWorkspace: [];
  rename: [id: string, title: string];
  archive: [id: string];
  fork: [id: string];
  renameWorkspace: [id: string, name: string];
  deleteWorkspace: [id: string];
  openSettings: [];
  collapse: [];
}>();

// ---------------------------------------------------------------------------
// Session search (title + last prompt, instant client-side filter)
// ---------------------------------------------------------------------------
const searchQuery = ref('');

const trimmedQuery = computed(() => searchQuery.value.trim());
const isSearching = computed(() => trimmedQuery.value.length > 0);

const searchResults = computed<Session[]>(() => {
  const q = trimmedQuery.value.toLowerCase();
  if (!q) return [];
  return props.sessions.filter((s) => {
    const title = (s.title ?? '').toLowerCase();
    const last = (s.lastPrompt ?? '').toLowerCase();
    return title.includes(q) || last.includes(q);
  });
});

function clearSearch(): void {
  searchQuery.value = '';
}

function onSelectResult(sessionId: string): void {
  clearSearch();
  onSelectSession(sessionId);
}

// ---------------------------------------------------------------------------
// Collapse groups
// ---------------------------------------------------------------------------
const collapsedIds = ref<Set<string>>(new Set());

function isCollapsed(id: string): boolean {
  return collapsedIds.value.has(id);
}

function toggleCollapse(id: string): void {
  const next = new Set(collapsedIds.value);
  if (next.has(id)) {
    next.delete(id);
    // Reset session expansion when workspace is expanded
    const expandedNext = new Set(expandedWsIds.value);
    expandedNext.delete(id);
    expandedWsIds.value = expandedNext;
  } else {
    next.add(id);
  }
  collapsedIds.value = next;
}

// ---------------------------------------------------------------------------
// Session list truncation per workspace
// ---------------------------------------------------------------------------
const DEFAULT_VISIBLE_COUNT = 10;

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

/** Show the most recent N sessions. If the active session is older than N,
    replace the last slot with it so the highlight never disappears. */
function visibleSessions(sessions: Session[], expanded: boolean, activeId?: string): Session[] {
  if (expanded || sessions.length <= DEFAULT_VISIBLE_COUNT) return sessions;
  const visible = sessions.slice(0, DEFAULT_VISIBLE_COUNT);
  if (activeId && !visible.some((s) => s.id === activeId)) {
    const active = sessions.find((s) => s.id === activeId);
    if (active) visible[DEFAULT_VISIBLE_COUNT - 1] = active;
  }
  return visible;
}

// ---------------------------------------------------------------------------
// Shift-multi-select workspaces
// ---------------------------------------------------------------------------
const selectedIds = ref<Set<string>>(new Set());

function handleGhClick(wsId: string, e: MouseEvent): void {
  if (e.shiftKey) {
    e.stopPropagation();
    const next = new Set(selectedIds.value);
    if (next.has(wsId)) next.delete(wsId);
    else next.add(wsId);
    selectedIds.value = next;
    emit('selectWorkspaces', Array.from(next));
    return;
  }
  // Normal click: clear multi-selection then toggle collapse
  selectedIds.value = new Set();
  emit('selectWorkspaces', []);
  toggleCollapse(wsId);
}

function onSelectSession(sessionId: string): void {
  selectedIds.value = new Set();
  emit('selectWorkspaces', []);
  emit('select', sessionId);
}

// ---------------------------------------------------------------------------
// Rename workspace (inline, like SessionRow)
// ---------------------------------------------------------------------------
const renamingId = ref<string | null>(null);
const renameValue = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);

// Hand the rename-input ref OBJECT (not its unwrapped value) down to
// WorkspaceGroup: top-level refs are auto-unwrapped in templates, so a getter
// keeps the ref intact. The child writes its input element back, and Sidebar
// keeps owning focus (startRenameWorkspace focuses it on nextTick).
function getRenameInputRef() {
  return renameInputRef;
}

function startRenameWorkspace(id: string, name: string): void {
  renamingId.value = id;
  renameValue.value = name;
  void nextTick().then(() => renameInputRef.value?.focus());
}

function confirmRenameWorkspace(): void {
  const id = renamingId.value;
  const name = renameValue.value.trim();
  if (id && name) {
    emit('renameWorkspace', id, name);
  }
  renamingId.value = null;
}

function cancelRenameWorkspace(): void {
  renamingId.value = null;
}

function onUpdateRenameValue(value: string): void {
  renameValue.value = value;
}

// ---------------------------------------------------------------------------
// Workspace right-click menu (copy path, rename)
// ---------------------------------------------------------------------------
const ghMenuOpen = ref(false);
const ghMenuTarget = ref<WorkspaceView | null>(null);
const ghMenuStyle = ref<Record<string, string>>({});
const ghMenuRef = ref<HTMLElement | null>(null);

function onGhMenuDocClick(e: MouseEvent): void {
  if (ghMenuRef.value && !ghMenuRef.value.contains(e.target as Node)) {
    closeGhMenu();
  }
}

function openGhMenu(ws: WorkspaceView, e: MouseEvent): void {
  if (e.shiftKey) {
    // shift+right-click = multi-select (same as shift+click)
    e.stopPropagation();
    const next = new Set(selectedIds.value);
    if (next.has(ws.id)) next.delete(ws.id);
    else next.add(ws.id);
    selectedIds.value = next;
    emit('selectWorkspaces', Array.from(next));
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  ghMenuTarget.value = ws;
  ghMenuStyle.value = {
    top: `${e.clientY}px`,
    left: `${e.clientX}px`,
  };
  ghMenuOpen.value = true;
  document.addEventListener('mousedown', onGhMenuDocClick, true);
}

function closeGhMenu(): void {
  ghMenuOpen.value = false;
  document.removeEventListener('mousedown', onGhMenuDocClick, true);
  ghMenuTarget.value = null;
  disarmDeleteWs();
}

function copyPathFromMenu(): void {
  if (ghMenuTarget.value) {
    void copyTextToClipboard(ghMenuTarget.value.root);
  }
  closeGhMenu();
}

function startRenameFromMenu(): void {
  if (ghMenuTarget.value) {
    startRenameWorkspace(ghMenuTarget.value.id, ghMenuTarget.value.name);
  }
  closeGhMenu();
}

function deleteFromMenu(): void {
  const ws = ghMenuTarget.value;
  if (!ws) return;
  if (!armDeleteWs(ws.id)) return; // first click arms ("confirm?"), keep menu open
  emit('deleteWorkspace', ws.id);
  closeGhMenu();
}

// ---------------------------------------------------------------------------
// Two-step workspace delete (shared by the kebab menu and the context menu):
// the first click arms the item — it turns into a "confirm" label — and a
// second click within 2.5s actually deletes; otherwise the item reverts.
// ---------------------------------------------------------------------------
const deleteArmedWsId = ref<string | null>(null);
let deleteArmTimer: ReturnType<typeof setTimeout> | undefined;

function disarmDeleteWs(): void {
  clearTimeout(deleteArmTimer);
  deleteArmedWsId.value = null;
}

/** Returns true when the delete is confirmed (second click while armed). */
function armDeleteWs(id: string): boolean {
  if (deleteArmedWsId.value === id) {
    disarmDeleteWs();
    return true;
  }
  clearTimeout(deleteArmTimer);
  deleteArmedWsId.value = id;
  deleteArmTimer = setTimeout(() => {
    deleteArmedWsId.value = null;
  }, 2500);
  return false;
}

// ---------------------------------------------------------------------------
// Workspace inline more-menu (kebab, hover-triggered). Rendered position:fixed
// and anchored to the ⋯ button so the scrolling session list can't clip it;
// it doesn't follow the anchor, so scroll/resize simply close it.
// ---------------------------------------------------------------------------
const wsMenuOpenId = ref<string | null>(null);
const wsMenuTarget = ref<WorkspaceView | null>(null);
const wsMenuStyle = ref<Record<string, string>>({});
const wsMenuRef = ref<HTMLElement | null>(null);

function onWsMenuDocClick(e: MouseEvent): void {
  const target = e.target as Element;
  if (target.closest('.gh-more') || target.closest('.ws-menu')) return;
  closeWsMenu();
}

async function toggleWsMenu(ws: WorkspaceView, e: MouseEvent): Promise<void> {
  if (wsMenuOpenId.value === ws.id) {
    closeWsMenu();
    return;
  }
  const btn = e.currentTarget as HTMLElement;
  wsMenuTarget.value = ws;
  wsMenuOpenId.value = ws.id;
  document.addEventListener('mousedown', onWsMenuDocClick);
  document.addEventListener('scroll', closeWsMenu, true);
  window.addEventListener('resize', closeWsMenu);
  await nextTick();
  const menu = wsMenuRef.value;
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
  wsMenuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  };
}

function closeWsMenu(): void {
  wsMenuOpenId.value = null;
  wsMenuTarget.value = null;
  disarmDeleteWs();
  document.removeEventListener('mousedown', onWsMenuDocClick);
  document.removeEventListener('scroll', closeWsMenu, true);
  window.removeEventListener('resize', closeWsMenu);
}

function copyWsPath(ws: WorkspaceView): void {
  void copyTextToClipboard(ws.root);
  closeWsMenu();
}

function startRenameWs(ws: WorkspaceView): void {
  startRenameWorkspace(ws.id, ws.name);
  closeWsMenu();
}

function deleteWs(ws: WorkspaceView): void {
  if (!armDeleteWs(ws.id)) return; // first click arms ("confirm?"), keep menu open
  emit('deleteWorkspace', ws.id);
  closeWsMenu();
}

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onGhMenuDocClick, true);
  document.removeEventListener('mousedown', onWsMenuDocClick);
  document.removeEventListener('scroll', closeWsMenu, true);
  window.removeEventListener('resize', closeWsMenu);
  clearTimeout(deleteArmTimer);
});

// Logo easter-egg: clicking the Kimi mark plays one quick blink. It's a one-shot
// animation — force a reflow so rapid clicks restart it, then drop the class so
// the idle look/blink loop resumes.
const logoRef = ref<SVGSVGElement | null>(null);
let blinkTimer: ReturnType<typeof setTimeout> | undefined;

// Temporarily hide the new-workspace button while we evaluate the entry point.
const showNewWorkspaceButton = false;

function blinkOnce(): void {
  const el = logoRef.value;
  if (!el) return;
  el.classList.remove('blink-now');
  void el.getBoundingClientRect();
  el.classList.add('blink-now');
  clearTimeout(blinkTimer);
  blinkTimer = setTimeout(() => el.classList.remove('blink-now'), 300);
}
</script>

<template>
  <aside class="side">
    <!-- Session column -->
    <div class="col" :style="{ width: colWidth + 'px' }">
      <!-- Header: logo + settings (no hard border — flows into workspace list) -->
      <div class="ch">
        <div class="ch-brand">
          <svg ref="logoRef" class="ch-logo" :class="{ 'is-dev': isDev }" viewBox="0 0 32 22" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Kimi Code" @click="blinkOnce">
            <defs>
              <mask id="kimiEyes" maskUnits="userSpaceOnUse">
                <rect x="0" y="0" width="32" height="22" fill="#fff" />
                <g class="ch-eyes" fill="#000">
                  <rect class="ch-eye" x="11.8" y="7" width="2.8" height="8" rx="1.4" />
                  <rect class="ch-eye" x="17.4" y="7" width="2.8" height="8" rx="1.4" />
                </g>
              </mask>
            </defs>
            <rect x="1" y="1" width="30" height="20" rx="6" fill="var(--logo)" mask="url(#kimiEyes)" />
          </svg>
          <span class="ch-name">Kimi Code<span v-if="isDev" class="ch-endpoint"> · {{ endpoint }}</span></span>
        </div>
        <button
          type="button"
          class="collapse-btn"
          :title="t('sidebar.collapseSidebar')"
          :aria-label="t('sidebar.collapseSidebar')"
          @click.stop="emit('collapse')"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M11 6h9" />
            <path d="M11 12h9" />
            <path d="M11 18h9" />
            <path d="M7 9l-3 3 3 3" />
          </svg>
        </button>
        <button
          type="button"
          class="settings-btn"
          :title="t('settings.title')"
          :aria-label="t('settings.title')"
          @click.stop="emit('openSettings')"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l-.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z" />
          </svg>
        </button>
      </div>

      <!-- Session search -->
      <div class="search">
        <svg class="search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="7" cy="7" r="5" />
          <path d="M11 11l3 3" />
        </svg>
        <input
          v-model="searchQuery"
          class="search-input"
          type="text"
          :placeholder="t('sidebar.searchPlaceholder')"
          :aria-label="t('sidebar.searchPlaceholder')"
          @keydown.esc.stop="clearSearch"
        />
        <button
          v-if="isSearching"
          type="button"
          class="search-clear"
          :title="t('sidebar.searchClear')"
          :aria-label="t('sidebar.searchClear')"
          @click.stop="clearSearch"
        >
          <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
          </svg>
        </button>
      </div>

      <!-- New chat + new workspace buttons -->
      <div class="btn-wrap">
        <button class="btn-new-chat" @click.stop="emit('create')">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 2.5h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8.5l-2.5 2V11.5H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z" />
          </svg>
          <span>{{ t('sidebar.newChat') }}</span>
        </button>
        <button
          v-if="showNewWorkspaceButton"
          type="button"
          class="btn-new-ws"
          :title="t('sidebar.newWorkspace')"
          :aria-label="t('sidebar.newWorkspace')"
          @click.stop="emit('addWorkspace')"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <path d="M1 3.5V2.5A1 1 0 0 1 2 1.5h3.5l1.3 2h5.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"/>
            <path d="M1 5.5h12"/>
          </svg>
        </button>
      </div>

      <!-- Search results (flat, across all workspaces) -->
      <div v-if="isSearching" class="sessions">
        <template v-if="searchResults.length > 0">
          <SessionRow
            v-for="s in searchResults"
            :key="s.id"
            :session="s"
            :active="s.id === activeId"
            :approval-count="pendingBySession[s.id]?.approvals ?? 0"
            :question-count="pendingBySession[s.id]?.questions ?? 0"
            :unread="unreadBySession[s.id] ?? false"
            @select="onSelectResult($event)"
            @rename="(id, title) => emit('rename', id, title)"
            @archive="emit('archive', $event)"
            @fork="emit('fork', $event)"
          />
        </template>
        <div v-else class="empty">
          {{ t('sidebar.searchNoResults') }}
        </div>
      </div>

      <!-- Session list — grouped by workspace -->
      <div v-else class="sessions">
        <!-- Empty state — only when no workspace is registered at all; empty
             workspaces still render their group header (with the + button). -->
        <div v-if="groups.length === 0" class="empty">
          {{ t('workspace.noWorkspace') }}
        </div>

        <template v-else>
          <WorkspaceGroup
            v-for="g in groups"
            :key="g.workspace.id"
            :group="g"
            :active-workspace-id="activeWorkspaceId"
            :active-id="activeId"
            :selected-ids="selectedIds"
            :renaming-id="renamingId"
            :rename-value="renameValue"
            :rename-input-ref="getRenameInputRef()"
            :pending-by-session="pendingBySession"
            :unread-by-session="unreadBySession"
            :ws-menu-open-id="wsMenuOpenId"
            :is-collapsed="isCollapsed"
            :is-expanded="isExpanded"
            :visible-sessions="visibleSessions"
            @group-click="handleGhClick"
            @group-contextmenu="openGhMenu"
            @toggle-ws-menu="toggleWsMenu"
            @create-in-workspace="(id) => emit('createInWorkspace', id)"
            @select-session="onSelectSession"
            @rename-session="(id, title) => emit('rename', id, title)"
            @archive-session="(id) => emit('archive', id)"
            @fork-session="(id) => emit('fork', id)"
            @toggle-expand="toggleExpand"
            @confirm-rename="confirmRenameWorkspace"
            @cancel-rename="cancelRenameWorkspace"
            @update-rename-value="onUpdateRenameValue"
          />
        </template>
      </div>
    </div>

    <!-- Workspace right-click menu (position:fixed) -->
    <div
      v-if="ghMenuOpen"
      ref="ghMenuRef"
      class="gh-menu"
      :style="ghMenuStyle"
      @click.stop
    >
      <button type="button" class="ghm-item" @click="copyPathFromMenu">
        {{ t('sidebar.copyPath') }}
      </button>
      <button type="button" class="ghm-item" @click="startRenameFromMenu">
        {{ t('sidebar.rename') }}
      </button>
      <button type="button" class="ghm-item del" @click="deleteFromMenu">
        {{ ghMenuTarget && deleteArmedWsId === ghMenuTarget.id ? t('sidebar.confirm') : t('sidebar.removeWorkspace') }}
      </button>
    </div>

    <!-- Workspace kebab menu (position:fixed, anchored to the ⋯ button so the
         scrolling session list cannot clip it) -->
    <div
      v-if="wsMenuOpenId !== null && wsMenuTarget"
      ref="wsMenuRef"
      class="ws-menu"
      :style="wsMenuStyle"
      @click.stop
    >
      <button class="ws-menu-item" @click.stop="copyWsPath(wsMenuTarget)">
        {{ t('sidebar.copyPath') }}
      </button>
      <div class="ws-menu-divider" />
      <button class="ws-menu-item" @click.stop="startRenameWs(wsMenuTarget)">
        {{ t('sidebar.rename') }}
      </button>
      <div class="ws-menu-divider" />
      <button class="ws-menu-item del" @click.stop="deleteWs(wsMenuTarget)">
        {{ deleteArmedWsId === wsMenuTarget.id ? t('sidebar.confirm') : t('sidebar.removeWorkspace') }}
      </button>
    </div>
  </aside>
</template>

<style scoped>
.side {
  border-right: 1px solid var(--line);
  background: var(--panel);
  display: flex;
  flex-direction: row;
  min-width: 0;
  height: 100%;
  /* Alignment contract, inherited by SessionRow and the theme overrides in
     style.css: text in the workspace header, the path line and session rows
     all starts at --sb-pad-x + --sb-gutter + --sb-gap from the sidebar edge. */
  --sb-pad-x: 16px;  /* row horizontal padding */
  --sb-gutter: 20px; /* leading icon slot (14px folder icon + 6px margin) */
  --sb-gap: 6px;     /* gap between the icon slot and the text */
}

/* Session column. Width is set inline from the App resize handle. */
.col {
  flex: none;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  width: 100%;
  container-type: inline-size;
  container-name: sidebar-col;
}

/* Header: logo + settings (no border — flows into the workspace list). */
.ch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  width: 100%;
  box-sizing: border-box;
}
.ch-logo {
  height: 22px;
  width: 32px;
  flex: none;
  display: block;
  cursor: pointer;
  user-select: none;
  transition: transform 0.18s ease;
}
.ch-logo:hover {
  transform: scale(1.08);
}
/* Dev-only: tint the mark yellow so a `pnpm dev:web` tab is obvious at a
   glance. `--logo` is read by the mark's `fill`; overriding it on the svg
   recolors just this instance. */
.ch-logo.is-dev {
  --logo: #f5b301;
}
.ch-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  /* Take the row's slack so the action buttons group together on the right. */
  flex: 1;
}
.ch-name {
  font-size: var(--ui-font-size);
  font-weight: 500;
  line-height: 22px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Dev-only: backend host:port appended to the title. Kept secondary so the
   product name still leads. */
.ch-endpoint {
  color: var(--muted);
  font-family: var(--mono);
  font-weight: 400;
  font-size: calc(var(--ui-font-size) - 1px);
}

/* In narrow sidebars the product name drops out so the logo keeps its fixed
   size and the action buttons remain reachable. */
@container sidebar-col (max-width: 250px) {
  .ch-name { display: none; }
}
.settings-btn,
.collapse-btn {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: none;
  border: none;
  color: var(--muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}
.settings-btn:hover,
.collapse-btn:hover { background: var(--soft); color: var(--ink); }
.settings-btn:focus-visible,
.collapse-btn:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
}

/* Action buttons */
 .btn-wrap {
  display: flex;
  gap: 8px;
  padding: 0 12px 8px;
}
.btn-wrap button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 10px;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  font-weight: 400;
  line-height: 1;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}
.btn-wrap button svg { flex: none; }
.btn-wrap button:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 1px;
}
.btn-wrap button span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.btn-new-chat {
  flex: 1;
  gap: 10px;
  color: var(--dim);
  background: transparent;
  border: 1px solid var(--line);
}
.btn-new-chat:hover {
  background: var(--panel);
  border-color: var(--bd);
  color: var(--ink);
}
.btn-new-ws {
  flex: none;
  justify-content: center;
  aspect-ratio: 1;
  padding: 9px 10px;
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--line);
}
.btn-new-ws:hover {
  background: var(--panel);
  border-color: var(--bd);
  color: var(--dim);
}

/* Session search */
.search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 12px 8px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
}
.search:focus-within {
  border-color: var(--bd);
  color: var(--ink);
}
.search-icon {
  flex: none;
}
.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--ink);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 1px);
}
.search-input::placeholder {
  color: var(--faint);
}
.search-clear {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.search-clear:hover {
  background: var(--soft);
  color: var(--ink);
}

/* Sessions */
.sessions {
  flex: 1;
  overflow-y: auto;
  padding: 0 0 8px;
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: var(--line) transparent;
}
.sessions::-webkit-scrollbar { width: 4px; }
.sessions::-webkit-scrollbar-track { background: transparent; }
.sessions::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: 2px;
}
.sessions::-webkit-scrollbar-thumb:hover { background: var(--bd); }

.empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--faint);
  font-size: calc(var(--ui-font-size) - 3px);
  line-height: 1.6;
}

/* Workspace kebab dropdown menu — fixed so the scroll container can't clip it;
   anchored to the ⋯ trigger from toggleWsMenu(). */
.ws-menu {
  position: fixed;
  top: 0;
  left: 0;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  z-index: 200;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  overflow: hidden;
  min-width: 88px;
}
.ws-menu-item {
  display: block;
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
.ws-menu-item:hover { background: var(--panel2); }

/* Danger items (delete workspace) — red in both light and dark schemes. */
.ws-menu-item.del,
.ghm-item.del { color: var(--err); }
.ws-menu-item.del:hover,
.ghm-item.del:hover {
  background: color-mix(in srgb, var(--err) 10%, transparent);
}

.ws-menu-divider {
  height: 1px;
  background: var(--line);
  margin: 2px 0;
}

/* ---------------------------------------------------------------------------
   Workspace right-click menu (position:fixed)
   --------------------------------------------------------------------------- */
.gh-menu {
  position: fixed;
  top: 0;
  left: 0;
  min-width: 140px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  padding: 4px;
  z-index: 200;
}
.ghm-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: var(--ui-font-size-xs);
  color: var(--text);
  background: transparent;
  border: none;
  cursor: pointer;
}
.ghm-item:hover {
  background: var(--soft);
}

</style>
