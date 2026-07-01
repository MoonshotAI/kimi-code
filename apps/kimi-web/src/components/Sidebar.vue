<!-- apps/kimi-web/src/components/Sidebar.vue -->
<!-- Unified sidebar: session groups with collapsible workspace headers.
     The old workspace rail and workspace tabs have been removed;
     workspace switching, folding and renaming all live in the group header. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { serverEndpointLabel } from '../api/config';
import { copyTextToClipboard } from '../lib/clipboard';
import {
  loadCollapsedWorkspaces,
  loadShowWorkspacePaths,
  saveCollapsedWorkspaces,
  saveShowWorkspacePaths,
} from '../lib/storage';
import { moveInOrder, type DropPosition, type WorkspaceSortMode } from '../lib/workspaceOrder';
import type { Session, WorkspaceGroup as WorkspaceGroupType, WorkspaceView } from '../types';
import SearchSessionsDialog from './dialogs/SearchSessionsDialog.vue';
import WorkspaceGroup from './WorkspaceGroup.vue';
import InternalBuildBanner from './InternalBuildBanner.vue';
import { isMacosDesktop } from '../lib/desktopFlag';
import IconButton from './ui/IconButton.vue';
import Icon from './ui/Icon.vue';
import Menu from './ui/Menu.vue';
import MenuItem from './ui/MenuItem.vue';
import Tooltip from './ui/Tooltip.vue';
import { useConfirmDialog } from '../composables/useConfirmDialog';

const { t } = useI18n();
const { confirm } = useConfirmDialog();

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
    /** Current workspace sort mode — drives the section-header sort button. */
    workspaceSortMode: WorkspaceSortMode;
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
  addWorkspace: [];
  rename: [id: string, title: string];
  archive: [id: string];
  fork: [id: string];
  renameWorkspace: [id: string, name: string];
  deleteWorkspace: [id: string];
  reorderWorkspaces: [ids: string[]];
  setWorkspaceSortMode: [mode: WorkspaceSortMode];
  loadMoreSessions: [workspaceId: string];
  loadAllSessions: [];
  openSettings: [];
  collapse: [];
}>();

// ---------------------------------------------------------------------------
// Session search dialog (Spotlight-style; filters title + last prompt)
// ---------------------------------------------------------------------------
const showSearch = ref(false);

function openSearch(): void {
  // Sessions are loaded per-workspace (first page only); lazily drain the rest
  // so the dialog's client-side filter covers everything.
  emit('loadAllSessions');
  showSearch.value = true;
}

function onSearchKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSearch();
  }
}

onMounted(() => window.addEventListener('keydown', onSearchKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onSearchKeydown));

// Scroll-linked header seam: the .btn-wrap bottom border/shadow only appears
// once the session list has actually scrolled, so an unscrolled list shows no
// abrupt boundary.
const sessionsScrolled = ref(false);
function onSessionsScroll(e: Event): void {
  sessionsScrolled.value = (e.target as HTMLElement).scrollTop > 0;
}

// ---------------------------------------------------------------------------
// Collapse groups
// ---------------------------------------------------------------------------
const collapsedIds = ref<Set<string>>(new Set(loadCollapsedWorkspaces()));

function isCollapsed(id: string): boolean {
  return collapsedIds.value.has(id);
}

function toggleCollapse(id: string): void {
  const next = new Set(collapsedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedIds.value = next;
  saveCollapsedWorkspaces(next);
}

function collapseAllWorkspaces(): void {
  const next = new Set(props.groups.map((g) => g.workspace.id));
  collapsedIds.value = next;
  saveCollapsedWorkspaces(next);
}

function expandAllWorkspaces(): void {
  const next = new Set<string>();
  collapsedIds.value = next;
  saveCollapsedWorkspaces(next);
}

// True when every workspace is collapsed — drives the single toggle button's
// icon (expand when fully collapsed, collapse otherwise) and action.
const allCollapsed = computed(
  () =>
    props.groups.length > 0 &&
    props.groups.every((g) => collapsedIds.value.has(g.workspace.id)),
);

// ---------------------------------------------------------------------------
// Workspace path display (toggle in the Workspaces section header)
// ---------------------------------------------------------------------------
// Off by default so the list stays compact; turning it on reveals every
// workspace's root path as a stable subtitle (no hover-induced layout shift).
const showWorkspacePaths = ref<boolean>(loadShowWorkspacePaths());

function toggleShowWorkspacePaths(): void {
  showWorkspacePaths.value = !showWorkspacePaths.value;
  saveShowWorkspacePaths(showWorkspacePaths.value);
}

// ---------------------------------------------------------------------------
// Workspace drag-to-reorder
// ---------------------------------------------------------------------------
// The header of each group is the drag handle (see WorkspaceGroup). We track
// which group is being dragged and where the insertion marker sits (before or
// after the group under the pointer), then on drop we emit the new id order
// upward — the parent persists it and the computed `groups` re-sorts. Using the
// pointer's position within the target (top half = before, bottom half = after)
// is what lets a workspace be dropped at the very bottom of the list.
const draggingWsId = ref<string | null>(null);
const dragOver = ref<{ id: string; position: DropPosition } | null>(null);

function onWsDragstart(id: string): void {
  draggingWsId.value = id;
}

function onWsDragend(): void {
  draggingWsId.value = null;
  dragOver.value = null;
}

function dropPosition(event: DragEvent): DropPosition {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function onGroupDragOver(event: DragEvent, targetId: string): void {
  if (draggingWsId.value === null || draggingWsId.value === targetId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dragOver.value = { id: targetId, position: dropPosition(event) };
}

function onGroupDrop(targetId: string): void {
  const fromId = draggingWsId.value;
  const position = dragOver.value?.id === targetId ? dragOver.value.position : 'before';
  dragOver.value = null;
  draggingWsId.value = null;
  if (!fromId || fromId === targetId) return;
  const next = moveInOrder(
    props.groups.map((g) => g.workspace.id),
    fromId,
    targetId,
    position,
  );
  emit('reorderWorkspaces', next);
}

function handleGhClick(wsId: string, e: MouseEvent): void {
  // Ignore clicks that land on the group's action buttons (kebab / add); those
  // have their own handlers and must not also toggle collapse.
  if ((e.target as Element).closest('.gh-more, .gh-add')) return;
  toggleCollapse(wsId);
}

function onSelectSession(sessionId: string): void {
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
const ghMenuRef = ref<InstanceType<typeof Menu> | null>(null);

function onGhMenuDocClick(e: MouseEvent): void {
  if (ghMenuRef.value?.el && !ghMenuRef.value.el.contains(e.target as Node)) {
    closeGhMenu();
  }
}

function openGhMenu(ws: WorkspaceView, e: MouseEvent): void {
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

async function deleteFromMenu(): Promise<void> {
  const ws = ghMenuTarget.value;
  if (!ws) return;
  closeGhMenu();
  if (
    await confirm({
      title: t('sidebar.removeWorkspace'),
      message: t('workspace.removeWorkspaceConfirm', { name: ws.name }),
      variant: 'danger',
    })
  ) {
    emit('deleteWorkspace', ws.id);
  }
}

// ---------------------------------------------------------------------------
// Workspace inline more-menu (kebab, hover-triggered). Rendered position:fixed
// and anchored to the ⋯ button so the scrolling session list can't clip it.
// It stays open on scroll (so a streaming turn doesn't dismiss it) and closes
// on outside-click or window resize.
// ---------------------------------------------------------------------------
const wsMenuOpenId = ref<string | null>(null);
const wsMenuTarget = ref<WorkspaceView | null>(null);
const wsMenuStyle = ref<Record<string, string>>({});
const wsMenuRef = ref<InstanceType<typeof Menu> | null>(null);

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
  window.addEventListener('resize', closeWsMenu);
  await nextTick();
  const menu = wsMenuRef.value?.el;
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
  document.removeEventListener('mousedown', onWsMenuDocClick);
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

async function deleteWs(ws: WorkspaceView): Promise<void> {
  closeWsMenu();
  if (
    await confirm({
      title: t('sidebar.removeWorkspace'),
      message: t('workspace.removeWorkspaceConfirm', { name: ws.name }),
      variant: 'danger',
    })
  ) {
    emit('deleteWorkspace', ws.id);
  }
}

// ---------------------------------------------------------------------------
// Workspace sort menu (triggered from the WORKSPACES section header). Anchored
// to the sort button via position:fixed so the scrolling list can't clip it.
// ---------------------------------------------------------------------------
const sortMenuOpen = ref(false);
const sortMenuStyle = ref<Record<string, string>>({});
const sortMenuRef = ref<InstanceType<typeof Menu> | null>(null);

function onSortMenuDocClick(e: MouseEvent): void {
  const target = e.target as Element;
  if (target.closest('.side-section-sort') || target.closest('.sort-menu')) return;
  closeSortMenu();
}

async function toggleSortMenu(e: MouseEvent): Promise<void> {
  if (sortMenuOpen.value) {
    closeSortMenu();
    return;
  }
  const btn = e.currentTarget as HTMLElement;
  sortMenuOpen.value = true;
  document.addEventListener('mousedown', onSortMenuDocClick);
  window.addEventListener('resize', closeSortMenu);
  await nextTick();
  const menu = sortMenuRef.value?.el;
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
  sortMenuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  };
}

function closeSortMenu(): void {
  sortMenuOpen.value = false;
  document.removeEventListener('mousedown', onSortMenuDocClick);
  window.removeEventListener('resize', closeSortMenu);
}

function chooseSortMode(mode: WorkspaceSortMode): void {
  emit('setWorkspaceSortMode', mode);
  closeSortMenu();
}

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onGhMenuDocClick, true);
  document.removeEventListener('mousedown', onWsMenuDocClick);
  document.removeEventListener('mousedown', onSortMenuDocClick);
  window.removeEventListener('resize', closeWsMenu);
  window.removeEventListener('resize', closeSortMenu);
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

// Logo long-press easter-egg: holding the Kimi mark for 1 second opens the
// design system page in a full-screen overlay. A short click still just blinks.
// Pointer capture keeps the hold alive even if the pointer drifts off the mark.
const showDesignSystem = ref(false);
const EGG_HOLD_MS = 1000;
let logoPressTimer: ReturnType<typeof setTimeout> | undefined;
let logoLongPressed = false;

function onLogoPointerDown(event: PointerEvent): void {
  logoLongPressed = false;
  clearTimeout(logoPressTimer);
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  logoPressTimer = setTimeout(() => {
    logoLongPressed = true;
    showDesignSystem.value = true;
  }, EGG_HOLD_MS);
}

function onLogoPointerUp(event: PointerEvent): void {
  clearTimeout(logoPressTimer);
  const el = event.currentTarget as HTMLElement;
  if (el.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId);
}

function onLogoClick(): void {
  if (logoLongPressed) {
    logoLongPressed = false;
    return;
  }
  blinkOnce();
}

function closeDesignSystem(): void {
  showDesignSystem.value = false;
}

function onDesignSystemKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && showDesignSystem.value) closeDesignSystem();
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onDesignSystemKeydown);
}
onBeforeUnmount(() => {
  clearTimeout(logoPressTimer);
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', onDesignSystemKeydown);
  }
});
</script>

<template>
  <aside class="side" :class="{ 'macos-desktop': isMacosDesktop }">
    <!-- Session column -->
    <div class="col" :style="{ width: colWidth + 'px' }">
      <!-- Header: logo + settings (no hard border — flows into workspace list) -->
      <div class="ch">
        <div class="ch-brand">
          <svg ref="logoRef" class="ch-logo" :class="{ 'is-dev': isDev }" viewBox="0 0 32 22" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Kimi Code" @click="onLogoClick" @pointerdown="onLogoPointerDown" @pointerup="onLogoPointerUp" @pointercancel="onLogoPointerUp">
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
          <InternalBuildBanner />
        </div>
        <Tooltip :text="t('sidebar.collapseSidebar')">
          <IconButton
            size="sm"
            :label="t('sidebar.collapseSidebar')"
            @click.stop="emit('collapse')"
          >
            <Icon name="panel-collapse" />
          </IconButton>
        </Tooltip>
        <Tooltip :text="t('settings.title')">
          <IconButton
            size="sm"
            :label="t('settings.title')"
            @click.stop="emit('openSettings')"
          >
            <Icon name="settings" />
          </IconButton>
        </Tooltip>
      </div>

      <!-- Session search — opens the Spotlight-style search dialog -->
      <button class="search" type="button" @click="openSearch">
        <Icon class="search-icon" name="search" />
        <span class="search-input">{{ t('sidebar.searchShortcut') }}</span>
      </button>

      <!-- New chat + new workspace buttons -->
      <div class="btn-wrap" :class="{ 'btn-wrap--scrolled': sessionsScrolled }">
        <button class="btn-new-chat" type="button" @click.stop="emit('create')">
          <Icon name="plus" />
          <span>{{ t('sidebar.newChat') }}</span>
        </button>
        <Tooltip :text="t('sidebar.newWorkspace')">
          <IconButton
            v-if="showNewWorkspaceButton"
            size="sm"
            :label="t('sidebar.newWorkspace')"
            @click.stop="emit('addWorkspace')"
          >
            <Icon name="folder" />
          </IconButton>
        </Tooltip>
      </div>

      <!-- Session list — grouped by workspace -->
      <div class="sessions" @scroll="onSessionsScroll">
        <!-- Empty state — only when no workspace is registered at all; empty
             workspaces still render their group header (with the + button). -->
        <div v-if="groups.length === 0" class="empty">
          {{ t('workspace.noWorkspace') }}
        </div>

        <template v-else>
          <div class="side-section-label">
            <span class="side-section-title">{{ t('sidebar.workspaces') }}</span>
            <div class="side-section-actions">
              <Tooltip :text="t('sidebar.sortWorkspaces')">
                <IconButton
                  class="side-section-toggle side-section-sort"
                  size="sm"
                  :label="t('sidebar.sortWorkspaces')"
                  aria-haspopup="menu"
                  :aria-expanded="sortMenuOpen"
                  @click.stop="toggleSortMenu($event)"
                >
                  <Icon :name="workspaceSortMode === 'recent' ? 'clock' : 'sort'" />
                </IconButton>
              </Tooltip>
              <Tooltip :text="allCollapsed ? t('sidebar.expandAll') : t('sidebar.collapseAll')">
                <IconButton
                  class="side-section-toggle"
                  size="sm"
                  :label="allCollapsed ? t('sidebar.expandAll') : t('sidebar.collapseAll')"
                  @click.stop="allCollapsed ? expandAllWorkspaces() : collapseAllWorkspaces()"
                >
                  <Icon v-if="allCollapsed" name="expand" />
                  <Icon v-else name="collapse" />
                </IconButton>
              </Tooltip>
              <Tooltip
                :text="showWorkspacePaths ? t('sidebar.hideWorkspacePaths') : t('sidebar.showWorkspacePaths')"
              >
                <IconButton
                  class="side-section-toggle"
                  :class="{ active: showWorkspacePaths }"
                  size="sm"
                  :label="showWorkspacePaths ? t('sidebar.hideWorkspacePaths') : t('sidebar.showWorkspacePaths')"
                  :aria-pressed="showWorkspacePaths"
                  @click.stop="toggleShowWorkspacePaths()"
                >
                  <Icon name="list" />
                </IconButton>
              </Tooltip>
            </div>
          </div>
          <div
            v-for="g in groups"
            :key="g.workspace.id"
            class="ws-drop-target"
            :class="{
              'drop-before': dragOver?.id === g.workspace.id && dragOver.position === 'before',
              'drop-after': dragOver?.id === g.workspace.id && dragOver.position === 'after',
            }"
            @dragover="onGroupDragOver($event, g.workspace.id)"
            @drop="onGroupDrop(g.workspace.id)"
          >
            <WorkspaceGroup
              :group="g"
              :active-workspace-id="activeWorkspaceId"
              :active-id="activeId"
              :renaming-id="renamingId"
              :rename-value="renameValue"
              :rename-input-ref="getRenameInputRef()"
              :pending-by-session="pendingBySession"
              :unread-by-session="unreadBySession"
              :ws-menu-open-id="wsMenuOpenId"
              :dragging="draggingWsId === g.workspace.id"
              :is-collapsed="isCollapsed"
              :show-path="showWorkspacePaths"
              @group-click="handleGhClick"
              @group-contextmenu="openGhMenu"
              @toggle-ws-menu="toggleWsMenu"
              @create-in-workspace="(id) => emit('createInWorkspace', id)"
              @select-session="onSelectSession"
              @rename-session="(id, title) => emit('rename', id, title)"
              @archive-session="(id) => emit('archive', id)"
              @fork-session="(id) => emit('fork', id)"
              @load-more="(id) => emit('loadMoreSessions', id)"
              @confirm-rename="confirmRenameWorkspace"
              @cancel-rename="cancelRenameWorkspace"
              @update-rename-value="onUpdateRenameValue"
              @ws-dragstart="onWsDragstart"
              @ws-dragend="onWsDragend"
            />
          </div>
        </template>
      </div>
    </div>

    <!-- Workspace right-click menu (position:fixed) -->
    <Menu
      v-if="ghMenuOpen"
      ref="ghMenuRef"
      class="gh-menu"
      :style="ghMenuStyle"
      @click.stop
    >
      <MenuItem @click="copyPathFromMenu">{{ t('sidebar.copyPath') }}</MenuItem>
      <MenuItem @click="startRenameFromMenu">{{ t('sidebar.rename') }}</MenuItem>
      <MenuItem danger @click="deleteFromMenu">{{ t('sidebar.removeWorkspace') }}</MenuItem>
    </Menu>

    <!-- Workspace kebab menu (position:fixed, anchored to the ⋯ button so the
         scrolling session list cannot clip it) -->
    <Menu
      v-if="wsMenuOpenId !== null && wsMenuTarget"
      ref="wsMenuRef"
      class="ws-menu"
      :style="wsMenuStyle"
      @click.stop
    >
      <MenuItem @click="copyWsPath(wsMenuTarget)">{{ t('sidebar.copyPath') }}</MenuItem>
      <MenuItem separator />
      <MenuItem @click="startRenameWs(wsMenuTarget)">{{ t('sidebar.rename') }}</MenuItem>
      <MenuItem separator />
      <MenuItem danger @click="deleteWs(wsMenuTarget)">{{ t('sidebar.removeWorkspace') }}</MenuItem>
    </Menu>
    <!-- Workspace sort menu (position:fixed, anchored to the sort button) -->
    <Menu
      v-if="sortMenuOpen"
      ref="sortMenuRef"
      class="sort-menu"
      :style="sortMenuStyle"
      @click.stop
    >
      <MenuItem :active="workspaceSortMode === 'manual'" @click="chooseSortMode('manual')">
        {{ t('sidebar.sortManual') }}
      </MenuItem>
      <MenuItem :active="workspaceSortMode === 'recent'" @click="chooseSortMode('recent')">
        {{ t('sidebar.sortRecent') }}
      </MenuItem>
    </Menu>
    <!-- Session search dialog (Cmd/Ctrl+K) -->
    <SearchSessionsDialog
      v-if="showSearch"
      :sessions="sessions"
      :active-id="activeId"
      @select="onSelectSession"
      @close="showSearch = false"
    />
    <Teleport to="body">
      <div
        v-if="showDesignSystem"
        class="ds-egg"
        @mousedown.self="closeDesignSystem"
      >
        <div class="ds-egg-frame">
          <div class="ds-egg-head">
            <span class="ds-egg-title">Design system</span>
            <IconButton size="sm" :label="t('diff.close')" @click="closeDesignSystem">
              <Icon name="close" size="md" />
            </IconButton>
          </div>
          <iframe class="ds-egg-iframe" src="/design-system.html" title="Design system" />
        </div>
      </div>
    </Teleport>
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
  /* Alignment contract, inherited by SessionRow and the de-terminalization
     rules in style.css: text in the workspace header, the path line and session
     rows all starts at --sb-pad-x + --sb-gutter + --sb-gap from the sidebar edge. */
  --sb-pad-x: var(--space-4);  /* row horizontal padding */
  --sb-gutter: 20px;           /* leading icon slot (14px folder icon + 6px margin) */
  --sb-gap: var(--space-2);    /* gap between the icon slot and the text */
  /* Sidebar reads at 16px, matching the chat content size. Override the global
     14px UI font on this subtree so the brand / action buttons / search (which
     derive from --ui-font-size) all scale up together. */
  --ui-font-size: 15px;
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
  padding: var(--space-3) var(--space-3) var(--space-2);
  width: 100%;
  box-sizing: border-box;
}
/* macOS desktop: the window uses a hidden title bar, so the traffic lights float
   over the top-left of the sidebar. Push the header content right to clear them,
   and turn the empty header area into the window-drag region; interactive
   controls opt out with no-drag. */
.side.macos-desktop .ch {
  padding-left: 80px;
  -webkit-app-region: drag;
}
.side.macos-desktop .ch-logo,
.side.macos-desktop .collapse-btn,
.side.macos-desktop .settings-btn {
  -webkit-app-region: no-drag;
}
.ch-logo {
  height: 22px;
  width: 32px;
  flex: none;
  display: block;
  cursor: pointer;
  user-select: none;
  touch-action: none;
  transition: transform 0.18s ease;
}
.ch-logo:hover {
  transform: scale(1.08);
}
/* Dev-only: tint the mark yellow so a `pnpm dev:web` tab is obvious at a
   glance. `--logo` is read by the mark's `fill`; overriding it on the svg
   recolors just this instance. */
.ch-logo.is-dev {
  --logo: var(--color-logo-dev);
}
.ch-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  /* Take the row's slack so the action buttons group together on the right. */
  flex: 1;
  user-select: none;
  touch-action: none;
}
.ch-name {
  font-size: 15px;
  font-weight: 500;
  line-height: 22px;
  color: var(--color-text);
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

/* Action buttons */
 .btn-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 var(--space-2) var(--space-2);
  position: relative;
  z-index: 1;
  background: var(--panel);
  border-bottom: 1px solid transparent;
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.btn-wrap--scrolled {
  border-bottom-color: var(--line);
  box-shadow: var(--shadow-sm);
}
.btn-new-chat {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
  min-height: 26px;
  padding: var(--space-1) calc(var(--sb-pad-x) - var(--space-2));
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size);
  cursor: pointer;
  text-align: left;
}
.btn-new-chat:hover { background: var(--color-surface-sunken); }
.btn-new-chat:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.btn-new-chat svg { flex: none; width: 16px; height: 16px; }
.btn-new-chat span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Session search */
.search {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 26px;
  margin: 0 var(--space-2) var(--space-2);
  padding: var(--space-1) calc(var(--sb-pad-x) - var(--space-2));
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.search:hover { background: var(--color-surface-sunken); }
.search:focus-visible {
  background: var(--color-surface-sunken);
  color: var(--color-text);
  outline: 2px solid var(--color-accent-bd);
  outline-offset: -2px;
}
.search-icon {
  flex: none;
}
.search-input {
  flex: 1;
  min-width: 0;
  color: var(--faint);
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Sessions */
.sessions {
  flex: 1;
  overflow-y: auto;
  padding: 0 var(--space-2) var(--space-2);
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: var(--line) transparent;
}
.sessions::-webkit-scrollbar { width: 4px; }
.sessions::-webkit-scrollbar-track { background: transparent; }
.sessions::-webkit-scrollbar-thumb {
  background: var(--line);
  border-radius: var(--radius-xs);
}
.sessions::-webkit-scrollbar-thumb:hover { background: var(--color-accent-bd); }

/* Section label — heads the workspace list below the action buttons. Aligns
   with the rows' leading inset (--sb-pad-x) so it reads as the list's title. */
.side-section-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 var(--space-3) var(--space-1) var(--space-2);
  font-size: var(--text-sm);
  font-weight: 500;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--faint);
  user-select: none;
}
.side-section-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-section-toggle {
  color: var(--faint);
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}
.side-section-label:hover .side-section-toggle,
.side-section-label:focus-within .side-section-toggle {
  opacity: 1;
}
.side-section-toggle:hover {
  color: var(--dim);
}
/* Active toggle (e.g. "show paths" is on): keep it visible and accent-colored
   even when the section label isn't hovered, so the on state is readable. */
.side-section-toggle.active {
  color: var(--color-accent);
  opacity: 1;
}
.side-section-toggle svg {
  width: 13px;
  height: 13px;
}
.side-section-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* Workspace drag-to-reorder: a line at the top (drop-before) or bottom
   (drop-after) of the group under the cursor marks where the dragged workspace
   will land. Inset shadows avoid layout shift. */
.ws-drop-target.drop-before { box-shadow: inset 0 2px 0 var(--color-accent); }
.ws-drop-target.drop-after { box-shadow: inset 0 -2px 0 var(--color-accent); }

.empty {
  padding: var(--space-6) var(--space-3);
  text-align: center;
  color: var(--faint);
  font-size: calc(var(--ui-font-size) - 3px);
  line-height: 1.6;
}

/* Workspace menus — surface + items come from Menu / MenuItem; only the
   fixed positioning stays here (anchored to the ⋯ trigger / cursor). */
.ws-menu,
.gh-menu,
.sort-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}

/* Logo long-press easter-egg: a dialog showing the design system page. */
.ds-egg {
  position: fixed;
  inset: 0;
  z-index: var(--z-max);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-6);
  background: rgba(13, 17, 23, 0.55);
}
.ds-egg-frame {
  display: flex;
  flex-direction: column;
  width: min(1100px, 94vw);
  height: min(820px, 92vh);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-xl);
  overflow: hidden;
}
.ds-egg-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 12px 18px;
  border-bottom: 1px solid var(--color-line);
}
.ds-egg-title {
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--color-text);
}
.ds-egg-iframe {
  flex: 1;
  min-height: 0;
  display: block;
  width: 100%;
  border: 0;
  background: #fff;
}
</style>
