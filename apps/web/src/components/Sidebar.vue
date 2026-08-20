<!-- apps/kimi-web/src/components/Sidebar.vue -->
<!-- Unified sidebar: session groups with collapsible workspace headers.
     The old workspace rail and workspace tabs have been removed;
     workspace switching, folding and renaming all live in the group header. -->
<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { visibleOpenGroups } from '@moonshot-ai/app-core/lib';
import {
  loadCollapsedWorkspaces,
  loadSidebarViewMode,
  openTabAttention,
  saveCollapsedWorkspaces,
  savePinnedCollapsed,
  saveSidebarViewMode,
  type SidebarViewMode,
} from '@moonshot-ai/app-core/lib';
import { SESSION_ROW_DRAG_MIME } from '@moonshot-ai/app-core/lib';
import { isSessionSearchKeyEvent } from '@moonshot-ai/app-core/lib';
import { moveInOrder, type DropPosition, type WorkspaceSortMode } from '@moonshot-ai/app-core/lib';
import {
  canDropWorkspaceFolders,
  extractDroppedFolderPaths,
  looksLikeFolderDrag,
} from '@moonshot-ai/app-core/lib';
import type { Session, WorkspaceGroup as WorkspaceGroupType, WorkspaceView } from '../types';
import SearchSessionsDialog from './dialogs/SearchSessionsDialog.vue';
import UserMenu from './UserMenu.vue';
import WorkspaceGroup from './WorkspaceGroup.vue';
import PinnedSessionList from './PinnedSessionList.vue';
import SessionRow from './SessionRow.vue';
import { isMacosDesktop } from '@moonshot-ai/app-core/lib';
import { useSidebarTabs } from '@moonshot-ai/app-core';
import { SESSIONS_EXPAND_BATCH } from '@moonshot-ai/app-client/client';
import { Icon, IconButton, Kbd, Menu, MenuItem, SegmentedControl, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    activeWorkspace: WorkspaceView | null;
    activeWorkspaceId: string | null;
    sessions: Session[];
    groups: WorkspaceGroupType[];
    /** Workspace sort mode for the grouped view: 'manual' (the user's dragged
     *  order, the default) or 'recent' (groups follow their latest activity).
     *  Drives the view menu's sort section; group dragging is suspended while
     *  'recent' (a drop would have no effect on a computed order). */
    workspaceSortMode?: WorkspaceSortMode;
    /** Pinned sessions (across workspaces, recency order) — rendered in the
     *  pinned section above all workspace groups; empty hides the section. */
    pinnedSessions?: Session[];
    /** Flat mode: every session across workspaces, newest first (pinned
     *  excluded — they render in the pinned section). */
    flatSessions?: Session[];
    /** Flat mode: whether the session-list endpoint reports more pages. */
    flatHasMore?: boolean;
    /** Flat mode: true while the next page is being fetched. */
    flatLoadingMore?: boolean;
    /** Status view's 已完成 tab: done (archived) sessions, updatedAt desc. */
    doneSessions?: Session[];
    /** Done tab: whether the endpoint reports more pages. */
    doneHasMore?: boolean;
    /** Done tab: true while the next page is being fetched. */
    doneLoadingMore?: boolean;
    /** True once the app's initial load() has settled — the flat seed waits
     *  for it (seeding earlier races load()'s wholesale pool replace). */
    initialized?: boolean;
    activeId: string;
    attentionBySession?: Record<string, number>;
    /** Per-session pending counts split by kind, for the coloured tags. */
    pendingBySession?: Record<string, { approvals: number; questions: number }>;
    unreadBySession?: Record<string, boolean>;
    /** Width (px) of the session column, driven by the App resize handle. */
    colWidth?: number;
    /** True when the sidebar is collapsed: the container animates to width 0
     *  (content keeps `colWidth` and is clipped), then hides itself. */
    collapsed?: boolean;
    /** True while the resize handle is dragged — disables the width transition
     *  so the sidebar follows the pointer 1:1. */
    dragging?: boolean;
  }>(),
  {
    activeWorkspace: null,
    activeWorkspaceId: null,
    workspaceSortMode: 'manual',
    pinnedSessions: () => [],
    flatSessions: () => [],
    flatHasMore: false,
    flatLoadingMore: false,
    doneSessions: () => [],
    doneHasMore: false,
    doneLoadingMore: false,
    initialized: false,
    attentionBySession: () => ({}),
    pendingBySession: () => ({}),
    unreadBySession: () => ({}),
    colWidth: 220,
    collapsed: false,
    dragging: false,
  },
);

const emit = defineEmits<{
  select: [sessionId: string];
  create: [];
  createInWorkspace: [workspaceId: string];
  selectWorkspace: [workspaceId: string];
  addWorkspace: [];
  /** Folders dropped onto the sidebar, resolved to absolute paths (desktop
   *  only — the flow is bridge-gated in lib/nativeWorkspaceDrop, so this
   *  never fires on web). */
  addWorkspacePaths: [paths: string[]];
  rename: [id: string, title: string];
  /** Gen Title (✨ in the session row's rename input): force-regenerate. */
  generateTitle: [id: string, done: (title: string | null) => void];
  archive: [id: string];
  /** Reopen a done session (status view's 已完成 tab rows / header button). */
  restore: [id: string];
  fork: [id: string];
  export: [id: string];
  pin: [id: string];
  /** A session row dropped into the pinned section (pin it; the section
   *  renders in recency order, so no position is carried). */
  dropPin: [id: string];
  unpin: [id: string];
  renameWorkspace: [id: string, name: string];
  deleteWorkspace: [id: string];
  reorderWorkspaces: [ids: string[]];
  setWorkspaceSortMode: [mode: WorkspaceSortMode];
  loadMoreSessions: [workspaceId: string];
  loadAllSessions: [];
  /** Flat mode: seed the first page (idempotent) / fetch the next page. */
  ensureFlatSessions: [];
  loadMoreFlatSessions: [];
  /** Status view's done list: seed the first page / fetch the next page. */
  ensureDoneSessions: [];
  loadMoreDoneSessions: [];
  /** Open the session admin page (the view menu's 会话管理… entry). */
  openSessionAdmin: [];
  openSettings: [];
  login: [];
  collapse: [];
}>();

// ---------------------------------------------------------------------------
// Session search dialog (Spotlight-style; filters title + last prompt)
// ---------------------------------------------------------------------------
const showSearch = ref(false);
const sessionSearchKeys = isAppleShortcutPlatform() ? ['⌘', 'K'] : ['Ctrl', 'K'];
// New chat is Ctrl+Shift+O on every platform (real Control key, ⌃ on macOS):
// browsers reserve ⌘N / Ctrl+N for "new window" and never deliver that
// keydown to the page, so the old chord could never fire outside Electron.
const newChatKeys = isAppleShortcutPlatform() ? ['⌃', '⇧', 'O'] : ['Ctrl', 'Shift', 'O'];

function openSearch(): void {
  // Sessions are loaded per-workspace (first page only); lazily drain the rest
  // so the dialog's client-side filter covers everything.
  emit('loadAllSessions');
  showSearch.value = true;
}

function onSearchKeydown(e: KeyboardEvent): void {
  // ⌘K on Apple / Ctrl+K elsewhere — the exact platform chord (see
  // sessionSearchShortcut): a plain Ctrl+K on macOS is the system "delete to
  // end of line" text edit and must reach the focused field untouched.
  if (isSessionSearchKeyEvent(e)) {
    e.preventDefault();
    openSearch();
    return;
  }
  if (!e.metaKey && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'o') {
    // See newChatKeys: ⌘N/Ctrl+N is reserved by the browser chrome, so new
    // chat listens for the Ctrl+Shift+O chord instead.
    e.preventDefault();
    emit('create');
  }
}

onMounted(() => window.addEventListener('keydown', onSearchKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onSearchKeydown));

function isAppleShortcutPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/Mac|iPod|iPhone|iPad/.test(navigator.platform)) return true;

  const userAgentData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return userAgentData?.platform === 'macOS' || userAgentData?.platform === 'iOS';
}

// Scroll-linked seams: each edge shows a soft fade only while more session
// content exists beyond that edge. This keeps the pinned actions and Settings
// entry readable without leaving a permanent shadow on a short list.
const sessionsEl = ref<HTMLElement | null>(null);
const sessionsScrolled = ref(false);
const sessionsCanScrollDown = ref(false);
// Overlay-style scrollbar: the thin thumb stays transparent until the list is
// actually scrolled, then lingers briefly and fades back out (see the
// .sessions::-webkit-scrollbar-thumb rules).
const sessionsScrolling = ref(false);
let sessionsScrollHideTimer: ReturnType<typeof setTimeout> | null = null;

function updateSessionsScrollState(el = sessionsEl.value): void {
  if (!el) return;
  sessionsScrolled.value = el.scrollTop > 0;
  sessionsCanScrollDown.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
}

function onSessionsScroll(e: Event): void {
  updateSessionsScrollState(e.target as HTMLElement);
  sessionsScrolling.value = true;
  if (sessionsScrollHideTimer) clearTimeout(sessionsScrollHideTimer);
  sessionsScrollHideTimer = setTimeout(() => {
    sessionsScrolling.value = false;
    sessionsScrollHideTimer = null;
  }, 900);
}

let sessionsResizeObserver: ResizeObserver | null = null;
onMounted(() => {
  nextTick(() => {
    updateSessionsScrollState();
    if (typeof ResizeObserver === 'function' && sessionsEl.value) {
      sessionsResizeObserver = new ResizeObserver(() => updateSessionsScrollState());
      sessionsResizeObserver.observe(sessionsEl.value);
    }
  });
});
onUpdated(() => updateSessionsScrollState());
onBeforeUnmount(() => {
  sessionsResizeObserver?.disconnect();
  if (sessionsScrollHideTimer) clearTimeout(sessionsScrollHideTimer);
  if (flashWsTimer) clearTimeout(flashWsTimer);
  if (flashSessionTimer) clearTimeout(flashSessionTimer);
});

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
// In-group expand / collapse (session pagination)
// ---------------------------------------------------------------------------
// Per-group display cap (rows); absent = the first page (`initialCount`).
// Ephemeral (not persisted): a refresh reloads only the first page, so every
// group starts collapsed. Expanding steps the cap up by one batch and fetches
// the next page only when the locally loaded rows can't cover the step — the
// user can't tell whether a reveal came from memory or the server. Collapsing
// resets to the first page without losing the already-loaded data.
const visibleLimits = ref<Map<string, number>>(new Map());

function visibleLimit(id: string): number | undefined {
  return visibleLimits.value.get(id);
}

function onExpand(id: string): void {
  const group = props.groups.find((g) => g.workspace.id === id);
  if (!group) return;
  const next = (visibleLimits.value.get(id) ?? group.initialCount) + SESSIONS_EXPAND_BATCH;
  const limits = new Map(visibleLimits.value);
  limits.set(id, next);
  visibleLimits.value = limits;
  // Locally loaded rows can't cover the new cap — pull the next page. The
  // fetch appends in place, so the rows show up under the same expanded cap.
  if (group.sessions.length < next && group.hasMore) {
    emit('loadMoreSessions', id);
  }
}

function onCollapse(id: string): void {
  if (!visibleLimits.value.has(id)) return;
  const limits = new Map(visibleLimits.value);
  limits.delete(id);
  visibleLimits.value = limits;
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

// ---------------------------------------------------------------------------
// Pinned-session drag-back (unpin)
// ---------------------------------------------------------------------------
// While a pinned row is dragged, the pinned list reports it here and every
// workspace group reads the ref: only the session's home workspace accepts
// the drop (which unpins); all other groups show the no-drop affordance. The
// state clears on dragend AND on the drop itself — the row unmounts mid-drag
// once the pin is removed, so dragend alone is not guaranteed to arrive.
const pinnedDragSession = ref<{ id: string; workspaceId: string } | null>(null);

function onPinnedSessionDragStart(id: string, workspaceId: string): void {
  pinnedDragSession.value = { id, workspaceId };
}

function onPinnedSessionDragEnd(): void {
  pinnedDragSession.value = null;
}

function onDropPinnedSession(id: string): void {
  pinnedDragSession.value = null;
  emit('unpin', id);
}

// ---------------------------------------------------------------------------
// List display mode within the session tabs: flat list vs grouped by workspace
// ---------------------------------------------------------------------------
// The status tabs (进行中 / 已完成 / 工作空间) are the sidebar's TOP level;
// 'flat'/'grouped' is the display switch INSIDE the open and done tabs (the
// workspace tab is a pure directory and ignores it). Persisted per device
// (lib/storage).
const listMode = ref<SidebarViewMode>(loadSidebarViewMode());

function setListMode(mode: SidebarViewMode): void {
  if (listMode.value === mode) return;
  listMode.value = mode;
  saveSidebarViewMode(mode);
}

// ---------------------------------------------------------------------------
// Status view tabs (进行中 / 已完成 / 工作空间). The open tab reuses the flat
// list's data; the done tab has its own paged list; workspaces is a pure
// directory (click = draft a session there). Ephemeral: the tab always opens
// on 进行中.
// ---------------------------------------------------------------------------
const statusTab = ref<'open' | 'done' | 'workspaces'>('open');

// 实验室开关「多标签页侧边栏」：关（默认）时退回单一会话列表——不渲染三 tab，
// statusTab 钉死在 'open'（完成/工作空间内容区随之不可达），会话管理入口隐藏。
const { sidebarTabs } = useSidebarTabs();
watch(sidebarTabs, (on) => {
  if (!on && statusTab.value !== 'open') statusTab.value = 'open';
});

// The open and done tabs carry no count — instead a blue dot (same accent as
// the rows' unread dot) flags that ANY loaded row in that tab wants attention:
// approval / question / aborted / unread, aggregated by priority. Plain
// running/idle shows nothing: the tab stays quiet for normal progress.
const openAttention = computed(() =>
  openTabAttention(
    [...props.pinnedSessions, ...props.flatSessions].map((s) => ({
      busy: s.busy,
      unread: props.unreadBySession[s.id] ?? false,
      questionCount: props.pendingBySession[s.id]?.questions ?? 0,
      approvalCount: props.pendingBySession[s.id]?.approvals ?? 0,
      pendingInteraction: s.pendingInteraction,
      lastTurnReason: s.lastTurnReason,
    })),
  ),
);

// Done rows can keep running (chatting in a completed session) and can raise
// approvals/questions — the done tab aggregates them exactly like the open tab.
const doneAttention = computed(() =>
  openTabAttention(
    props.doneSessions.map((s) => ({
      busy: s.busy,
      unread: props.unreadBySession[s.id] ?? false,
      questionCount: props.pendingBySession[s.id]?.questions ?? 0,
      approvalCount: props.pendingBySession[s.id]?.approvals ?? 0,
      pendingInteraction: s.pendingInteraction,
      lastTurnReason: s.lastTurnReason,
    })),
  ),
);

const TAB_ATTENTION_SWATCH = 'var(--color-accent)';

const statusTabOptions = computed(() => [
  {
    value: 'open',
    label: t('sidebar.tabOpen'),
    swatch: openAttention.value === null ? undefined : TAB_ATTENTION_SWATCH,
  },
  {
    value: 'done',
    label: t('sidebar.tabDone'),
    swatch: doneAttention.value === null ? undefined : TAB_ATTENTION_SWATCH,
  },
  { value: 'workspaces', label: t('sidebar.tabWorkspaces') },
]);

function setStatusTab(tab: string): void {
  // 单列表形态下 tab 不可切换（快捷键路径也走这里）——钉死 进行中。
  if (!sidebarTabs.value) return;
  statusTab.value = tab as 'open' | 'done' | 'workspaces';
  if (tab === 'done') emit('ensureDoneSessions');
}

// Open tab, grouped: which groups render is decided by visibleOpenGroups —
// the status-tabs view hides session-less workspaces (the 工作空间 tab is
// their directory for new sessions); the legacy single-list form has no such
// tab, so it keeps every group — archiving a workspace's last session must
// not make the workspace unreachable there.
const openGroups = computed(() =>
  visibleOpenGroups(props.groups, props.activeWorkspaceId, sidebarTabs.value),
);

// Done tab, grouped: aggregate the done rows under each workspace (in the
// user's workspace order); workspaces with no done sessions are skipped.
// cwdLabel is stripped so the rows render as single-line group rows (the
// workspace name is already the group header).
const doneGroups = computed(() =>
  props.groups
    .map((g) => ({
      workspace: g.workspace,
      sessions: props.doneSessions
        .filter((s) => s.workspaceId === g.workspace.id)
        .map((s) => ({ ...s, cwdLabel: undefined })),
    }))
    .filter((g) => g.sessions.length > 0),
);

// Seed both session lists once the app's initial load() has settled: seeding
// earlier races load()'s wholesale pool replace, which would drop v2-only
// page-1 rows while the flat cursor has already moved past them.
watch(
  () => props.initialized,
  (ready) => {
    if (!ready) return;
    emit('ensureFlatSessions');
    emit('ensureDoneSessions');
  },
  { immediate: true },
);

// The switcher is a dropdown anchored to the section-toggle button — same
// positioning language as the workspace kebab menu (toggleWsMenu): right-
// aligned under the trigger, flipping up when the bottom edge wouldn't fit.
const viewMenuOpen = ref(false);
const viewMenuStyle = ref<Record<string, string>>({});
const viewMenuRef = ref<InstanceType<typeof Menu> | null>(null);

function onViewMenuDocClick(e: MouseEvent): void {
  const target = e.target as Element;
  if (target.closest('.view-menu') || target.closest('.side-section-view')) return;
  closeViewMenu();
}

async function toggleViewMenu(e: MouseEvent): Promise<void> {
  if (viewMenuOpen.value) {
    closeViewMenu();
    return;
  }
  const btn = e.currentTarget as HTMLElement;
  viewMenuOpen.value = true;
  document.addEventListener('mousedown', onViewMenuDocClick);
  window.addEventListener('resize', closeViewMenu);
  await nextTick();
  const menu = viewMenuRef.value?.el;
  const r = btn.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuH = menu?.offsetHeight ?? 0;
  const menuW = menu?.offsetWidth ?? 0;
  let top = r.bottom + gap;
  let flipped = false;
  if (top + menuH > window.innerHeight - margin) {
    top = Math.max(margin, r.top - menuH - gap);
    flipped = true;
  }
  let left = r.right - menuW;
  if (left < margin) left = margin;
  // The pop animation grows out of the trigger corner — the origin and the
  // nudge direction follow the upward flip.
  viewMenuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    transformOrigin: flipped ? 'bottom right' : 'top right',
    '--menu-pop-shift': flipped ? '2px' : '-2px',
  };
}

function closeViewMenu(): void {
  viewMenuOpen.value = false;
  document.removeEventListener('mousedown', onViewMenuDocClick);
  window.removeEventListener('resize', closeViewMenu);
}

function chooseListMode(mode: SidebarViewMode): void {
  setListMode(mode);
  closeViewMenu();
}

function chooseSortMode(mode: WorkspaceSortMode): void {
  emit('setWorkspaceSortMode', mode);
  closeViewMenu();
}

function openSessionAdmin(): void {
  emit('openSessionAdmin');
  closeViewMenu();
}

// Flat rows double as drag sources for the pinned section — the same marker
// MIME as the grouped rows (WorkspaceGroup), so PinnedSessionList's
// pin-at-drop-position works unchanged. Dragging is suspended while a row is
// being renamed inline (text selection would otherwise start a row drag),
// mirroring the pinned section's rename-state-change handling.
const renamingFlatId = ref<string | null>(null);

function onFlatSessionDragStart(id: string, event: DragEvent): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(SESSION_ROW_DRAG_MIME, id);
  event.dataTransfer.setData('text/plain', id);
}

// Drag-back-to-unpin in flat-style lists: the grouped mode's home-group rule
// can't apply (these lists hold every workspace's sessions), so the whole
// list is the drop target — dropping anywhere unpins. Applies when the open
// tab shows its flat variant. Handlers sit on the .sessions scroll container
// and are gated on the flat-style list being shown, so the grouped groups
// keep their own home-group handling (events bubble up harmlessly).
const flatLikeListActive = computed(
  () => statusTab.value === 'open' && listMode.value === 'flat',
);
const flatPinnedDropHover = ref(false);

function onSessionsPinnedDragOver(event: DragEvent): void {
  if (!flatLikeListActive.value || pinnedDragSession.value === null) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  flatPinnedDropHover.value = true;
}

function onSessionsPinnedDrop(event: DragEvent): void {
  if (!flatLikeListActive.value || pinnedDragSession.value === null) return;
  event.preventDefault();
  flatPinnedDropHover.value = false;
  onDropPinnedSession(pinnedDragSession.value.id);
}

function onSessionsPinnedDragLeave(event: DragEvent): void {
  if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) return;
  flatPinnedDropHover.value = false;
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

function onSearchSelectSession(sessionId: string): void {
  emit('select', sessionId);
  locateSession(sessionId);
}

// ---------------------------------------------------------------------------
// Locate a session picked in the search dialog
// ---------------------------------------------------------------------------
// Same landing as the workspace locate, but for one row: grouped view, its
// group expanded, the row scrolled to the top of the list and flashed. The
// select above made the session active synchronously, so WorkspaceGroup's
// active-append renders the row on this flush even past the group's display
// cap — no limit bump (which would mount every row up to the target). A
// pinned session has no group row; it renders in the pinned section above
// the groups, so the locate expands/scrolls and flashes it there — opening
// its home workspace would re-select the workspace's newest session and yank
// the user away from the session they just picked.
const flashSessionId = ref<string | null>(null);
let flashSessionTimer: ReturnType<typeof setTimeout> | null = null;

// Workspaces in sidebar display order — feeds the search dialog's workspace
// section. (Named for the dialog: the task view's own `workspaceOptions`
// computed lives in its section below.)
const searchWorkspaces = computed(() => props.groups.map((g) => g.workspace));

/** Resolve a CSS duration token (e.g. --duration-flash) on an element to ms,
 *  so the flash-cleanup timer stays sourced from the same token as the
 *  animation instead of duplicating the value. */
function readDurationMs(el: HTMLElement, token: string): number {
  const raw = getComputedStyle(el).getPropertyValue(token).trim();
  const match = /^([\d.]+)(ms|s)$/.exec(raw);
  if (!match) return 0;
  const value = Number.parseFloat(match[1]!);
  return match[2] === 's' ? value * 1000 : value;
}

/** scrollIntoView behavior honoring prefers-reduced-motion: the long smooth
 *  travel to a far-off target is exactly the motion the preference opts out
 *  of — jump instantly there instead. */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function flashSessionRow(sessionId: string, row: HTMLElement): void {
  flashSessionId.value = sessionId;
  if (flashSessionTimer) clearTimeout(flashSessionTimer);
  flashSessionTimer = setTimeout(() => {
    flashSessionId.value = null;
    flashSessionTimer = null;
  }, readDurationMs(row, '--duration-flash'));
}

function locateSession(sessionId: string): void {
  const group = props.groups.find((g) => g.sessions.some((s) => s.id === sessionId));
  if (!group) {
    // A folded pinned section renders no rows at all, and the rows scroll in
    // their own 40vh container — expand first, then scroll the row into view
    // before flashing (same landing as a grouped row).
    pinnedListRef.value?.expand();
    void nextTick(() => {
      const root = pinnedListRef.value?.$el as HTMLElement | null;
      const row = [...(root?.querySelectorAll<HTMLElement>('[data-session-id]') ?? [])].find(
        (el) => el.dataset.sessionId === sessionId,
      );
      row?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
      if (row) flashSessionRow(sessionId, row);
    });
    return;
  }
  // Session groups render in the open tab's grouped variant — switch to it.
  if (statusTab.value !== 'open') setStatusTab('open');
  if (listMode.value !== 'grouped') setListMode('grouped');
  if (isCollapsed(group.workspace.id)) toggleCollapse(group.workspace.id);
  void nextTick(() => {
    const row = [...(sessionsEl.value?.querySelectorAll<HTMLElement>('[data-session-id]') ?? [])].find(
      (el) => el.dataset.sessionId === sessionId,
    );
    row?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
    if (row) flashSessionRow(sessionId, row);
  });
}

// ---------------------------------------------------------------------------
// Locate a workspace picked in the search dialog
// ---------------------------------------------------------------------------
// Workspace groups only render in the grouped view, so locating switches to it
// first; the target group is then expanded, scrolled to the top of the list and
// flashed, and the workspace itself is opened (its most recent session
// activates) — one click lands you exactly where the row pointed.
const flashWsId = ref<string | null>(null);
let flashWsTimer: ReturnType<typeof setTimeout> | null = null;

function onSearchSelectWorkspace(workspaceId: string): void {
  // Workspace groups render in the open tab's grouped variant — switch to it.
  if (statusTab.value !== 'open') setStatusTab('open');
  if (listMode.value !== 'grouped') setListMode('grouped');
  if (isCollapsed(workspaceId)) toggleCollapse(workspaceId);
  emit('selectWorkspace', workspaceId);
  void nextTick(() => {
    const target = [...(sessionsEl.value?.querySelectorAll<HTMLElement>('[data-ws-id]') ?? [])].find(
      (el) => el.dataset.wsId === workspaceId,
    );
    target?.scrollIntoView({ block: 'start', behavior: scrollBehavior() });
    if (!target) return;
    flashWsId.value = workspaceId;
    if (flashWsTimer) clearTimeout(flashWsTimer);
    flashWsTimer = setTimeout(() => {
      flashWsId.value = null;
      flashWsTimer = null;
    }, readDurationMs(target, '--duration-flash'));
  });
}

// Explicit pins (row button, context menu, drop into the section, and the
// chat header's ⋮ menu via the exposed method) re-expand a folded pinned
// section so the new row is seen — PinnedSessionList owns the fold state and
// exposes expand() for exactly this path.
const pinnedListRef = ref<InstanceType<typeof PinnedSessionList> | null>(null);

// Re-expand a folded pinned section before a pin lands, so the new row is
// visible. Exposed for pin entries that don't pass through this component
// (the chat header's ⋮ menu calls it from App.vue).
function revealPinnedSection(): void {
  // The pinned section only mounts on the 进行中 tab — a header-menu pin can
  // land while the user sits on 已完成 / 工作空间, so switch back first
  // (setStatusTab is a no-op in the legacy single-list form).
  if (statusTab.value !== 'open') setStatusTab('open');
  if (pinnedListRef.value) {
    pinnedListRef.value.expand();
  } else {
    // Section unmounted (zero pinned rows — e.g. the last one was archived
    // from outside the sidebar while folded): expand() is unreachable, so
    // clear the persisted fold here; the remounting list would re-read it
    // and hide this first pin.
    savePinnedCollapsed(false);
  }
}

defineExpose({ revealPinnedSection });

function onPinSession(id: string): void {
  revealPinnedSection();
  emit('pin', id);
}

function onDropPin(id: string): void {
  pinnedListRef.value?.expand();
  emit('dropPin', id);
}

// ---------------------------------------------------------------------------
// Folder drag & drop → add workspace (desktop only)
// ---------------------------------------------------------------------------
// Dropping folders anywhere on the sidebar registers each as a workspace.
// Everything is bridge-gated (lib/nativeWorkspaceDrop): without the desktop
// preload nothing here activates and drops keep their old meaning (file
// attachments, via the document-level handlers in useAttachmentUpload).
// Internal drags (workspace reorder) carry a text/plain payload, so they
// never match the folder heuristic. Like the composer overlay, a counter
// tracks nested dragenter/dragleave pairs instead of single events.
const folderDropDepth = ref(0);
const folderDropActive = ref(false);

function folderDropReset(): void {
  folderDropDepth.value = 0;
  folderDropActive.value = false;
}

function onFolderDragEnter(event: DragEvent): void {
  if (!canDropWorkspaceFolders() || !looksLikeFolderDrag(event)) return;
  // stopPropagation keeps the document-level attachment handlers from seeing
  // this drag — the composer overlay must not light up for a workspace drop.
  event.preventDefault();
  event.stopPropagation();
  folderDropDepth.value += 1;
  folderDropActive.value = true;
}

function onFolderDragOver(event: DragEvent): void {
  if (!canDropWorkspaceFolders() || !looksLikeFolderDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
}

function onFolderDragLeave(event: DragEvent): void {
  // Deliberately NOT stopPropagation'd: the document-level handlers pair
  // their own enter/leave bookkeeping (floored at 0, so the asymmetry from
  // the swallowed enters above is harmless).
  if (!canDropWorkspaceFolders() || !looksLikeFolderDrag(event)) return;
  folderDropDepth.value = Math.max(0, folderDropDepth.value - 1);
  if (folderDropDepth.value === 0) folderDropActive.value = false;
}

function onFolderDrop(event: DragEvent): void {
  folderDropReset();
  if (!canDropWorkspaceFolders()) return;
  const paths = extractDroppedFolderPaths(event);
  // Not folders after all (e.g. an extensionless file matched the dragover
  // heuristic) — don't intercept; let the drop bubble to the attachment flow.
  if (paths.length === 0) return;
  event.preventDefault();
  event.stopPropagation();
  emit('addWorkspacePaths', paths);
}

// ---------------------------------------------------------------------------
// Rename workspace (inline, like SessionRow)
// ---------------------------------------------------------------------------
const renamingId = ref<string | null>(null);
const renameValue = ref('');
const renameOriginal = ref('');
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
  renameOriginal.value = name;
  renameValue.value = name;
  void nextTick().then(() => renameInputRef.value?.focus());
}

function confirmRenameWorkspace(): void {
  const id = renamingId.value;
  const name = renameValue.value.trim();
  // Same no-op guard as session rename: an untouched rename must not hit the
  // daemon (the PATCH bumps updated_at).
  if (id && name && name !== renameOriginal.value) {
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

// The workspaces tab hosts its rename input directly (the grouped views' one
// lives in WorkspaceGroup) — IME guard so an Enter that only confirms a
// composition candidate never commits.
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } =
  useImeComposition();

function onDirRenameEnter(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;
  confirmRenameWorkspace();
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
    // The pop animation grows out of the trigger corner — for a context
    // menu that's the cursor (the menu opens down-right of it).
    transformOrigin: 'top left',
    '--menu-pop-shift': '-2px',
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

function deleteFromMenu(): void {
  const ws = ghMenuTarget.value;
  if (!ws) return;
  closeGhMenu();
  // The modal confirm + async delete live in App.vue (confirmDeleteWorkspace).
  emit('deleteWorkspace', ws.id);
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
  let flipped = false;
  if (top + menuH > window.innerHeight - margin) {
    top = Math.max(margin, r.top - menuH - gap);
    flipped = true;
  }
  let left = r.right - menuW;
  if (left < margin) left = margin;
  // The pop animation grows out of the trigger corner — the origin and the
  // nudge direction follow the upward flip.
  wsMenuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    transformOrigin: flipped ? 'bottom right' : 'top right',
    '--menu-pop-shift': flipped ? '2px' : '-2px',
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

function deleteWs(ws: WorkspaceView): void {
  closeWsMenu();
  // The modal confirm + async delete live in App.vue (confirmDeleteWorkspace).
  emit('deleteWorkspace', ws.id);
}

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onGhMenuDocClick, true);
  document.removeEventListener('mousedown', onWsMenuDocClick);
  document.removeEventListener('mousedown', onViewMenuDocClick);
  window.removeEventListener('resize', closeWsMenu);
  window.removeEventListener('resize', closeViewMenu);
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
// design system as a full-screen overlay. A short click still just blinks.
// Pointer capture keeps the hold alive even if the pointer drifts off the mark.
const DesignSystemView = defineAsyncComponent(
  () => import('../views/DesignSystemView.vue'),
);
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

onBeforeUnmount(() => {
  clearTimeout(logoPressTimer);
});
</script>

<template>
  <aside
    class="side"
    :class="{ 'macos-desktop': isMacosDesktop, collapsed, 'no-anim': dragging }"
    :style="{ width: collapsed ? '0px' : colWidth + 'px' }"
  >
    <!-- Session column -->
    <div
      class="col"
      :style="{ width: colWidth + 'px' }"
      @dragenter="onFolderDragEnter"
      @dragover="onFolderDragOver"
      @dragleave="onFolderDragLeave"
      @drop="onFolderDrop"
    >
      <!-- Header: brand + collapse. The collapse button lives INSIDE the header
           on non-mac platforms (right-aligned); on macOS desktop the brand is
           hidden (traffic lights own that corner) and the header is just a
           window-drag strip — there the toggle is App.vue's resident floating
           button beside the traffic lights. -->
      <div class="ch">
        <div class="ch-brand">
          <template v-if="!isMacosDesktop">
            <!-- Brand mark: the legacy "little blue" (rounded rect with eye
                 cutouts). WEB FORK — desktop ships the robot mascot generated by
                 scripts/build-brand-icons.mjs; the generator no longer touches
                 this file, so keep this divergence on purpose. The
                 .ch-eyes/.ch-eye classes hook the shared idle look/blink
                 keyframes in style.css (the eyes are mask cutouts, so animating
                 them moves the transparent holes). -->
            <svg ref="logoRef" class="ch-logo" viewBox="0 0 32 22" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Kimi Code" @click="onLogoClick" @pointerdown="onLogoPointerDown" @pointerup="onLogoPointerUp" @pointercancel="onLogoPointerUp">
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
            <span class="ch-name">Kimi Code</span>
          </template>
        </div>
        <div class="ch-tail">
          <IconButton
            v-if="!isMacosDesktop"
            class="ch-collapse"
            size="sm"
            :label="t('sidebar.collapseSidebar')"
            :tooltip="t('sidebar.collapseSidebar')"
            @click.stop="emit('collapse')"
          >
            <Icon name="panel-collapse" />
          </IconButton>
        </div>
      </div>

      <!-- Sidebar actions share one container so New chat and Search are true
           sibling controls. The optional workspace action occupies column 2. -->
      <div
        class="sidebar-actions"
        :class="{
          'sidebar-actions--has-workspace-action': showNewWorkspaceButton,
        }"
      >
        <button class="btn-new-chat" type="button" @click.stop="emit('create')">
          <Icon name="chat-new" />
          <span>{{ t('sidebar.newChat') }}</span>
          <Kbd :keys="newChatKeys" />
        </button>
        <IconButton
          v-if="showNewWorkspaceButton"
          size="sm"
          :label="t('sidebar.newWorkspace')"
          @click.stop="emit('addWorkspace')"
        >
          <Icon name="folder" />
        </IconButton>
        <button class="search" type="button" @click="openSearch">
          <Icon class="search-icon" name="search" />
          <span class="search-input">{{ t('sidebar.search') }}</span>
          <Kbd :keys="sessionSearchKeys" />
        </button>
      </div>

      <!-- The 进行中 / 已完成 / 工作空间 tabs are the sidebar's top level when
           the 实验室 multi-tab toggle is on; the single-list form (toggle off)
           skips them and pins statusTab to 'open'. Flat/grouped is a display
           switch inside the two session tabs (the section label's switcher
           below). -->
      <div v-if="sidebarTabs" class="status-tabs">
        <SegmentedControl
          class="status-seg"
          size="sm"
          :model-value="statusTab"
          :options="statusTabOptions"
          @update:model-value="setStatusTab"
        />
      </div>

      <!-- Fixed head above the scroll container (same pattern as
           .sidebar-actions / .side-footer): the pinned section and the
           section label stay put while the list scrolls under them, so the
           block also owns the scroll-linked seam at its bottom edge. -->
      <div
        class="sessions-head"
        :class="{ 'sessions-head--scrolled': sessionsScrolled }"
      >
        <!-- Pinned section: above every caption, listing pinned sessions
             across all workspaces — open tab only (pinned sessions are open
             by definition: completing one unpins it). -->
        <PinnedSessionList
          v-if="pinnedSessions.length > 0 && statusTab === 'open'"
          ref="pinnedListRef"
          :sessions="pinnedSessions"
          :active-id="activeId"
          :pending-by-session="pendingBySession"
          :unread-by-session="unreadBySession"
          state-tag="open"
          :flash-session-id="flashSessionId"
          @select-session="onSelectSession"
          @rename-session="(id, title) => emit('rename', id, title)"
          @generate-session-title="(id, done) => emit('generateTitle', id, done)"
          @archive-session="(id) => emit('archive', id)"
          @fork-session="(id) => emit('fork', id)"
          @export-session="(id) => emit('export', id)"
          @pin-session="onPinSession"
          @drop-pin="onDropPin"
          @session-drag-start="onPinnedSessionDragStart"
          @session-drag-end="onPinnedSessionDragEnd"
        />
        <div class="side-section-label">
          <span class="side-section-title">{{
            statusTab === 'workspaces'
              ? t('sidebar.tabWorkspaces')
              : statusTab === 'done'
                ? t('sidebar.tabDone')
                : t('sidebar.sessionsHeader')
          }}</span>
          <div class="side-section-actions">
            <!-- Workspace tab: the new-workspace entry lives here (icon +
                 tooltip), not as a row at the list bottom. -->
            <Tooltip v-if="statusTab === 'workspaces'" :text="t('sidebar.newWorkspace')">
              <IconButton
                class="side-section-toggle"
                size="sm"
                :label="t('sidebar.newWorkspace')"
                @click.stop="emit('addWorkspace')"
              >
                <Icon name="folder-plus" />
              </IconButton>
            </Tooltip>
            <IconButton
              v-if="statusTab !== 'workspaces' && listMode === 'grouped'"
              class="side-section-toggle"
              size="sm"
              :label="allCollapsed ? t('sidebar.expandAll') : t('sidebar.collapseAll')"
              :tooltip="allCollapsed ? t('sidebar.expandAll') : t('sidebar.collapseAll')"
              @click.stop="allCollapsed ? expandAllWorkspaces() : collapseAllWorkspaces()"
            >
              <Icon v-if="allCollapsed" name="expand" />
              <Icon v-else name="collapse" />
            </IconButton>
            <!-- Display switcher (flat / grouped within the session tabs):
                 opens a dropdown picking the presentation. Fixed icon (does
                 not follow the current mode) with a hover tooltip; rightmost
                 of the section actions; always visible. -->
            <Tooltip v-if="statusTab !== 'workspaces'" :text="t('sidebar.viewSwitcher')">
              <IconButton
                class="side-section-toggle side-section-view"
                size="sm"
                :label="t('sidebar.viewSwitcher')"
                @click.stop="toggleViewMenu"
              >
                <Icon name="list-settings" />
              </IconButton>
            </Tooltip>
          </div>
        </div>
      </div>

      <!-- Session list — per statusTab (open / done / workspaces); the session
           tabs render grouped by workspace or flat (all sessions, newest
           first) depending on listMode. The scroll container doubles as the
           flat mode's drag-back-to-unpin target (grouped mode keeps that on
           the home workspace group). -->
      <div
        ref="sessionsEl"
        class="sessions"
        :class="{
          scrolling: sessionsScrolling,
          'pinned-drag-active': flatLikeListActive && pinnedDragSession !== null,
          'flat-pinned-drop-hover': flatPinnedDropHover,
        }"
        @scroll="onSessionsScroll"
        @dragover="onSessionsPinnedDragOver"
        @drop="onSessionsPinnedDrop"
        @dragleave="onSessionsPinnedDragLeave"
      >
        <!-- 进行中：open sessions. Flat variant = the flat list's rows (all
             workspaces, newest first); grouped variant = the per-workspace
             groups (both carry the Open state tag). -->
        <template v-if="statusTab === 'open'">
          <template v-if="listMode === 'flat'">
            <SessionRow
              v-for="s in flatSessions"
              :key="s.id"
              :session="s"
              :active="s.id === activeId"
              :approval-count="pendingBySession[s.id]?.approvals ?? 0"
              :question-count="pendingBySession[s.id]?.questions ?? 0"
              :unread="unreadBySession[s.id] ?? false"
              state-tag="open"
              :draggable="renamingFlatId !== s.id"
              @dragstart="onFlatSessionDragStart(s.id, $event)"
              @rename-state-change="renamingFlatId = $event ? s.id : null"
              @select="onSelectSession"
              @rename="(id, title) => emit('rename', id, title)"
              @generate-title="(id, done) => emit('generateTitle', id, done)"
              @archive="(id) => emit('archive', id)"
              @fork="(id) => emit('fork', id)"
              @export="(id) => emit('export', id)"
              @pin="onPinSession"
            />
            <!-- Empty state only once the endpoint reports no more pages —
                 while the first page is in flight the list is simply blank
                 (hasMore starts true), so there is no empty-state flash. And
                 not while pinned rows remain above: they ARE the visible
                 history. -->
            <div
              v-if="flatSessions.length === 0 && !flatHasMore && pinnedSessions.length === 0"
              class="empty"
            >
              {{ t('sidebar.noSessions') }}
            </div>
            <!-- Manual paging: the next page loads only on an explicit click.
                 Centered, icon trailing — a quiet link-style button. -->
            <div v-if="flatHasMore" class="show-more-row">
              <button
                class="show-more"
                :disabled="flatLoadingMore"
                @click.stop="emit('loadMoreFlatSessions')"
              >
                <span class="show-more-label">{{
                  flatLoadingMore ? t('sidebar.loadingMore') : t('sidebar.loadMore')
                }}</span>
                <Icon name="chevron-down" size="sm" />
              </button>
            </div>
          </template>
          <template v-else>
            <!-- Empty states — no workspace registered at all, or every
                 workspace is session-less (e.g. right after a mass cleanup;
                 the pinned section above still counts as open sessions). -->
            <div v-if="groups.length === 0" class="empty">
              {{ t('workspace.noWorkspace') }}
            </div>
            <div v-else-if="openGroups.length === 0 && pinnedSessions.length === 0" class="empty">
              {{ t('sidebar.noOpenSessions') }}
            </div>
            <template v-else>
              <div
                v-for="g in openGroups"
                :key="g.workspace.id"
                class="ws-drop-target"
                :data-ws-id="g.workspace.id"
                :class="{
                  'drop-before': dragOver?.id === g.workspace.id && dragOver.position === 'before',
                  'drop-after': dragOver?.id === g.workspace.id && dragOver.position === 'after',
                  'ws-locate-flash': flashWsId === g.workspace.id,
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
                  :sortable="workspaceSortMode === 'manual'"
                  :is-collapsed="isCollapsed"
                  :visible-limit="visibleLimit"
                  :flash-session-id="flashSessionId"
                  :pinned-drag-session="pinnedDragSession"
                  state-tag="open"
                  @group-click="handleGhClick"
                  @group-contextmenu="openGhMenu"
                  @toggle-ws-menu="toggleWsMenu"
                  @create-in-workspace="(id) => emit('createInWorkspace', id)"
                  @select-session="onSelectSession"
                  @rename-session="(id, title) => emit('rename', id, title)"
                  @generate-session-title="(id, done) => emit('generateTitle', id, done)"
                  @archive-session="(id) => emit('archive', id)"
                  @fork-session="(id) => emit('fork', id)"
                  @export-session="(id) => emit('export', id)"
                  @pin-session="onPinSession"
                  @drop-pinned-session="onDropPinnedSession"
                  @expand="onExpand"
                  @collapse="onCollapse"
                  @confirm-rename="confirmRenameWorkspace"
                  @cancel-rename="cancelRenameWorkspace"
                  @update-rename-value="onUpdateRenameValue"
                  @ws-dragstart="onWsDragstart"
                  @ws-dragend="onWsDragend"
                />
              </div>
            </template>
          </template>
        </template>

        <!-- 已完成：done (archived) sessions, updatedAt desc (display and
             sort share the field). Flat variant = the paged done list;
             grouped variant aggregates the loaded done rows under their
             workspace (collapse shared with the open tab's groups). Row
             action = reopen. -->
        <template v-else-if="statusTab === 'done'">
          <template v-if="listMode === 'flat'">
            <SessionRow
              v-for="s in doneSessions"
              :key="s.id"
              :session="s"
              :active="s.id === activeId"
              :approval-count="pendingBySession[s.id]?.approvals ?? 0"
              :question-count="pendingBySession[s.id]?.questions ?? 0"
              :unread="unreadBySession[s.id] ?? false"
              state-tag="done"
              @select="onSelectSession"
              @rename="(id, title) => emit('rename', id, title)"
              @generate-title="(id, done) => emit('generateTitle', id, done)"
              @restore="(id) => emit('restore', id)"
              @fork="(id) => emit('fork', id)"
              @export="(id) => emit('export', id)"
            />
          </template>
          <template v-else>
            <div v-for="g in doneGroups" :key="g.workspace.id" class="done-group">
              <div
                class="done-gh"
                @click="toggleCollapse(g.workspace.id)"
                @contextmenu="openGhMenu(g.workspace, $event)"
              >
                <Icon v-if="isCollapsed(g.workspace.id)" class="done-gh-folder" name="folder-closed" />
                <Icon v-else class="done-gh-folder" name="folder" />
                <span class="done-gh-name">{{ g.workspace.name }}</span>
                <span class="done-gh-count">{{ g.sessions.length }}</span>
                <span class="done-gh-act">
                  <IconButton
                    class="gh-more"
                    :class="{ open: wsMenuOpenId === g.workspace.id }"
                    size="sm"
                    :label="t('sidebar.options')"
                    :tooltip="t('sidebar.options')"
                    aria-haspopup="menu"
                    :aria-expanded="wsMenuOpenId === g.workspace.id"
                    @click.stop="toggleWsMenu(g.workspace, $event)"
                  >
                    <Icon name="dots-horizontal" />
                  </IconButton>
                </span>
              </div>
              <div v-if="!isCollapsed(g.workspace.id)" class="done-sessions">
                <SessionRow
                  v-for="s in g.sessions"
                  :key="s.id"
                  :session="s"
                  :active="s.id === activeId"
                  :approval-count="pendingBySession[s.id]?.approvals ?? 0"
                  :question-count="pendingBySession[s.id]?.questions ?? 0"
                  :unread="unreadBySession[s.id] ?? false"
                  state-tag="done"
                  @select="onSelectSession"
                  @rename="(id, title) => emit('rename', id, title)"
                  @generate-title="(id, done) => emit('generateTitle', id, done)"
                  @restore="(id) => emit('restore', id)"
                  @fork="(id) => emit('fork', id)"
                  @export="(id) => emit('export', id)"
                />
              </div>
            </div>
          </template>
          <div v-if="doneSessions.length === 0 && !doneHasMore" class="empty">
            {{ t('sidebar.noDoneSessions') }}
          </div>
          <div v-if="doneHasMore" class="show-more-row">
            <button
              class="show-more"
              :disabled="doneLoadingMore"
              @click.stop="emit('loadMoreDoneSessions')"
            >
              <span class="show-more-label">{{
                doneLoadingMore ? t('sidebar.loadingMore') : t('sidebar.loadMore')
              }}</span>
              <Icon name="chevron-down" size="sm" />
            </button>
          </div>
        </template>

        <!-- 工作空间：a pure directory — click drafts a session in that
             workspace (no tab switch); the ⋯ / right-click menu keeps the
             workspace management entries (copy path, rename, remove). -->
        <template v-else>
          <div
            v-for="g in groups"
            :key="g.workspace.id"
            class="ws-dir"
            :class="{ on: g.workspace.id === activeWorkspaceId }"
            @click="emit('createInWorkspace', g.workspace.id)"
            @contextmenu="openGhMenu(g.workspace, $event)"
          >
            <div class="ws-dir-row">
              <Icon class="ws-dir-icon" name="folder-closed" />
              <!-- Inline rename lives right here in this tab (the grouped
                   views' input is WorkspaceGroup's) — Enter commits, Esc/blur
                   cancels; clicks stay off the row's create-session target. -->
              <input
                v-if="renamingId === g.workspace.id"
                :ref="(el) => (renameInputRef = el as HTMLInputElement | null)"
                v-model="renameValue"
                class="ws-dir-rename"
                type="text"
                @keydown.enter.stop="onDirRenameEnter"
                @keydown.esc.stop="cancelRenameWorkspace()"
                @compositionstart="handleCompositionStart"
                @compositionend="handleCompositionEnd"
                @blur="cancelRenameWorkspace()"
                @click.stop
              />
              <span v-else class="ws-dir-name">{{ g.workspace.name }}</span>
              <span class="ws-dir-act">
                <IconButton
                  v-if="renamingId !== g.workspace.id"
                  class="gh-more"
                  :class="{ open: wsMenuOpenId === g.workspace.id }"
                  size="sm"
                  :label="t('sidebar.options')"
                  :tooltip="t('sidebar.options')"
                  aria-haspopup="menu"
                  :aria-expanded="wsMenuOpenId === g.workspace.id"
                  @click.stop="toggleWsMenu(g.workspace, $event)"
                >
                  <Icon name="dots-horizontal" />
                </IconButton>
              </span>
            </div>
            <div class="ws-dir-sub">{{ g.workspace.root }}</div>
          </div>
          <div v-if="groups.length === 0" class="empty">
            {{ t('workspace.noWorkspace') }}
          </div>
        </template>
      </div>

      <!-- Footer: account area (user menu) pinned under the session list -->
      <div class="side-footer" :class="{ 'side-footer--shadowed': sessionsCanScrollDown }">
        <UserMenu @login="emit('login')" @open-settings="emit('openSettings')" />
      </div>

      <!-- Folder-drop affordance (desktop only): shown while a folder drag
           hovers the sidebar. Purely visual (pointer-events none) — the
           handlers on .col receive the drop. Pure CSS show/hide like the
           composer's drop overlay (a <Transition> can strand an invisible
           node when the drag ends before the enter transition starts). -->
      <div class="folder-drop-overlay" :class="{ show: folderDropActive }" aria-hidden="true">
        <div class="folder-drop-card">
          <Icon name="folder" size="lg" />
          <span>{{ t('sidebar.dropToAddWorkspace') }}</span>
        </div>
      </div>
    </div>

    <!-- Workspace right-click menu (position:fixed) -->
    <Transition name="menu-pop">
      <Menu
        v-if="ghMenuOpen"
        ref="ghMenuRef"
        class="gh-menu"
        :style="ghMenuStyle"
        @click.stop
      >
        <MenuItem @click="copyPathFromMenu">
          <Icon name="copy" size="sm" />
          {{ t('sidebar.copyPath') }}
        </MenuItem>
        <MenuItem class="workspace-rename-item" @click="startRenameFromMenu">
          <Icon name="pencil" size="sm" />
          {{ t('sidebar.rename') }}
        </MenuItem>
        <MenuItem danger @click="deleteFromMenu">
          <Icon name="close" size="sm" />
          {{ t('sidebar.removeWorkspace') }}
        </MenuItem>
      </Menu>
    </Transition>

    <!-- Workspace kebab menu (position:fixed, anchored to the ⋯ button so the
         scrolling session list cannot clip it) -->
    <Transition name="menu-pop">
      <Menu
        v-if="wsMenuOpenId !== null && wsMenuTarget"
        ref="wsMenuRef"
        class="ws-menu"
        :style="wsMenuStyle"
        @click.stop
      >
        <MenuItem @click="copyWsPath(wsMenuTarget)">
          <Icon name="copy" size="sm" />
          {{ t('sidebar.copyPath') }}
        </MenuItem>
        <MenuItem class="workspace-rename-item" @click="startRenameWs(wsMenuTarget)">
          <Icon name="pencil" size="sm" />
          {{ t('sidebar.rename') }}
        </MenuItem>
        <MenuItem danger @click="deleteWs(wsMenuTarget)">
          <Icon name="close" size="sm" />
          {{ t('sidebar.removeWorkspace') }}
        </MenuItem>
      </Menu>
    </Transition>
    <!-- View switcher dropdown (position:fixed, anchored to the section
         toggle): flat vs grouped presentation within the session tabs; the
         current one carries a checkmark at the row's right edge. -->
    <Transition name="menu-pop">
      <Menu
        v-if="viewMenuOpen"
        ref="viewMenuRef"
        class="view-menu"
        :style="viewMenuStyle"
        @click.stop
      >
        <div class="view-menu-label">{{ t('sidebar.viewGroup') }}</div>
        <MenuItem @click="chooseListMode('flat')">
          <Icon name="list" size="sm" />
          {{ t('sidebar.viewFlat') }}
          <span class="view-menu-check">
            <Icon v-if="listMode === 'flat'" name="check" size="sm" />
          </span>
        </MenuItem>
        <MenuItem @click="chooseListMode('grouped')">
          <Icon name="tree-view" size="sm" />
          {{ t('sidebar.viewGrouped') }}
          <span class="view-menu-check">
            <Icon v-if="listMode === 'grouped'" name="check" size="sm" />
          </span>
        </MenuItem>
        <!-- Group-order section: only meaningful in the grouped display (the
             flat list has no groups to order). -->
        <template v-if="listMode === 'grouped'">
          <div class="view-menu-label">{{ t('sidebar.sortGroup') }}</div>
          <MenuItem @click="chooseSortMode('manual')">
            <Icon name="grip" size="sm" />
            {{ t('sidebar.sortManual') }}
            <span class="view-menu-check">
              <Icon v-if="workspaceSortMode === 'manual'" name="check" size="sm" />
            </span>
          </MenuItem>
          <MenuItem @click="chooseSortMode('recent')">
            <Icon name="clock" size="sm" />
            {{ t('sidebar.sortRecent') }}
            <span class="view-menu-check">
              <Icon v-if="workspaceSortMode === 'recent'" name="check" size="sm" />
            </span>
          </MenuItem>
        </template>
        <!-- Cross-workspace management lives on its own page — separated from
             the display options above; a plain navigation entry (no check).
             单列表形态（实验室开关关）下不提供会话管理入口。 -->
        <template v-if="sidebarTabs">
          <MenuItem separator />
          <MenuItem @click="openSessionAdmin">
            <Icon name="session-admin" size="sm" />
            {{ t('sidebar.sessionAdmin') }}
          </MenuItem>
        </template>
      </Menu>
    </Transition>
    <!-- Session search dialog (Cmd/Ctrl+K) -->
    <SearchSessionsDialog
      v-if="showSearch"
      :sessions="sessions"
      :workspaces="searchWorkspaces"
      :active-id="activeId"
      @select="onSearchSelectSession"
      @select-workspace="onSearchSelectWorkspace"
      @close="showSearch = false"
    />
    <!-- Keep inside <aside>: a top-level <Teleport> makes Sidebar multi-root,
         which breaks v-show on the host (Vue can't apply display:none to a
         Fragment). Teleport still renders to body regardless of placement. -->
    <Teleport to="body">
      <DesignSystemView v-if="showDesignSystem" @close="showDesignSystem = false" />
    </Teleport>
  </aside>
</template>

<style scoped>
.side {
  /* Sidebar sits on its own surface (--color-sidebar-bg, one step off --bg);
     the 1px hairline on .col still separates it from the conversation pane. */
  background: var(--color-sidebar-bg);
  display: flex;
  flex-direction: row;
  /* Anchor content to the right edge: while the container width animates to 0
     the fixed-width column slides out to the left and is clipped, instead of
     reflowing. Mirrors the right-side preview panel (App.vue .global-preview). */
  justify-content: flex-end;
  overflow: hidden;
  min-width: 0;
  height: 100%;
  transition:
    width 0.28s cubic-bezier(0.4, 0, 0.2, 1),
    visibility 0.28s;
  /* Alignment contract, inherited by SessionRow and WorkspaceGroup:
     - row boxes (hover/selected pills) sit --sb-inset from the sidebar edges;
     - text/icons start at --sb-pad-x = --sb-inset + 8px row padding;
     - row titles start at --sb-pad-x + --sb-gutter + --sb-gap;
     - every trailing action button (row hover cluster, group-head ⋯/+,
       section-label buttons) shares one right edge: --sb-action-inset inside
       the row box's right border. The scrolling list reserves its scrollbar
       track (--space-1) at all times (scrollbar-gutter: stable) and the
       section labels' right padding adds the same track width, so the line
       holds whether or not the list scrolls. */
  --sb-inset: var(--space-2);  /* row box inset from the sidebar edge */
  --sb-pad-x: var(--space-4);  /* content start x (inset + row padding) */
  --sb-gutter: 16px;           /* leading icon slot (matches the 16px folder icon, so the session title aligns under the workspace name) */
  --sb-gap: var(--space-2);    /* gap between the icon slot and the text */
  /* Trailing action buttons sit this far inside the row box's right edge —
     the same inset as the buttons' vertical one, so a button is equidistant
     from the pill's right and top/bottom edges. The inset is half the row's
     vertical slack: the row height is font-driven (title line box =
     --ui-font-size-sm × --leading-tight, floored at the group-head /
     directory rows' 16px folder icon, plus 2 × --space-2 vertical padding —
     the .se/.gh 8px) minus the fixed IconButton sm box, so the whole
     expression tracks the user's font scale. */
  --sb-action-inset: calc((max(var(--ui-font-size-sm) * var(--leading-tight), var(--p-ic-md)) + 2 * var(--space-2) - var(--icon-button-sm)) / 2);
  /* Row hover wash — global --color-hover (lighter than the selected fill;
     both translucent, so they sit on any surface). */
  --sb-hover: var(--color-hover);
  --sb-selected: color-mix(in srgb, var(--color-selected) 75%, transparent);
}
/* The frosted-sidebar tint is desktop-only (apps/desktop): the web copy has
   no vibrancy window behind it and stays on the opaque --color-sidebar-bg. */
/* While dragging the resize handle, follow the pointer 1:1 (same pattern as
   .global-preview.no-anim in App.vue). */
.side.no-anim {
  transition: none;
}
/* Fully collapsed: width 0 (animated), then drop out of hit-testing / tab
   order once the transition ends (visibility interpolates to hidden at the
   end when collapsing, and back to visible immediately when expanding). */
.side.collapsed {
  visibility: hidden;
}

/* Session column. Width is set inline from the App resize handle; it stays
   fixed while the collapsing container clips it. Carries the sidebar's right
   hairline so the border is clipped away together with the content. */
.col {
  flex: none;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  border-right: 0.5px solid var(--line);
  container-type: inline-size;
  container-name: sidebar-col;
  /* Anchor for the folder-drop overlay. */
  position: relative;
}

/* Header: brand strip (no border — flows into the workspace list). On non-mac
   platforms the brand sits on the left and the collapse button on the right
   (justify-content: space-between); on macOS desktop the brand is hidden and
   the header is a window-drag strip (see below). min-height keeps the 26px
   control row (50px total with padding) so the list below starts at a stable
   y. */
.ch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: var(--space-3);
  min-height: calc(26px + 2 * var(--space-3));
  width: 100%;
  box-sizing: border-box;
}
/* macOS desktop: the window uses a hidden title bar, so the traffic lights
   float over the top-left of the sidebar and the resident toggle sits beside
   them. The header renders no content here (brand hidden) — it is purely a
   window-drag strip. */
.side.macos-desktop .ch {
  padding-left: 80px;
  -webkit-app-region: drag;
}
.side.macos-desktop .ch-brand {
  display: none;
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
/* Right-end header controls: collapse toggle + update pill. margin-left:auto
   covers macOS desktop, where the brand is hidden and the strip would
   otherwise left-align them next to the traffic lights. */
.ch-tail {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  min-width: 0;
  margin-left: auto;
}
.ch-name {
  font-size: var(--ui-font-size);
  font-weight: 500;
  line-height: 22px;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Responsive brand row: below 250px the product name drops out so the logo
   and action buttons keep their room. */
@container sidebar-col (max-width: 250px) {
  .ch-name { display: none; }
}

/* New chat and Search are direct siblings in one action group. The grid keeps
   the optional workspace action beside New chat while Search spans both
   columns on the next row. */
.sidebar-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0 var(--space-2);
  padding: 0 var(--sb-inset) var(--space-1);
  position: relative;
  z-index: 1;
  background: var(--color-sidebar-bg);
}

/* Fixed head — pinned section + WORKSPACES label, pinned above the scrolling
   group list. It owns the scroll-linked list seam (hairline + fade) at its
   bottom edge, shown only while the group list is scrolled. No background:
   nothing scrolls under it, so the surface shows through unchanged. The
   scrollbar-track compensation for the right edge lives on the section
   labels' own padding (see .side-section-label), NOT here — keeping the
   head symmetric keeps the pinned section's drop-active frame symmetric
   too. */
.sessions-head {
  position: relative;
  z-index: 1;
  padding: var(--space-3) var(--sb-inset) 0;
  border-bottom: 0.5px solid transparent;
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.sessions-head::after,
.side-footer::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: var(--p-sidebar-seam-h);
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}
.sessions-head::after {
  top: 100%;
  background:
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1.5%, transparent), transparent 35%),
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1%, transparent), transparent 65%),
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 0.75%, transparent), transparent);
  transition-duration: var(--duration-slow);
}
.sessions-head--scrolled {
  border-bottom-color: var(--line);
}
.sessions-head--scrolled::after { opacity: 1; }
.btn-new-chat {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
  width: 100%;
  min-width: 0;
  padding: 8px calc(var(--sb-pad-x) - var(--sb-inset));
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  cursor: pointer;
  text-align: left;
}
.sidebar-actions--has-workspace-action .btn-new-chat { grid-column: 1; }
.btn-new-chat:hover { background: var(--sb-hover); }
.btn-new-chat:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.btn-new-chat svg { flex: none; }
.btn-new-chat span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.btn-new-chat :deep(.ui-kbd) { margin-left: auto; }

.btn-new-chat :deep(.ui-kbd),
.search :deep(.ui-kbd) {
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}
.btn-new-chat:hover :deep(.ui-kbd),
.btn-new-chat:focus-visible :deep(.ui-kbd),
.search:hover :deep(.ui-kbd),
.search:focus-visible :deep(.ui-kbd) {
  opacity: 1;
}

.search {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
  width: 100%;
  margin: 0;
  padding: 8px calc(var(--sb-pad-x) - var(--sb-inset));
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.search:hover { background: var(--sb-hover); }
.search:focus-visible {
  background: var(--sb-hover);
  color: var(--color-text);
  outline: 2px solid var(--color-accent-bd);
  outline-offset: -2px;
}
.search-icon {
  flex: none;
  transform: translateY(-0.5px);
}
.search-input {
  flex: 1;
  min-width: 0;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Status view tabs — the design-system SegmentedControl (sm), stretched to
   the full column width; items share it evenly. Sits on its own row under
   the action buttons. */
.status-tabs {
  padding: var(--space-2) var(--sb-inset) 0;
}
.status-seg {
  width: 100%;
  display: flex;
}
.status-seg :deep(.ui-seg__item) {
  flex: 1;
  min-width: 0;
  justify-content: center;
  padding: 0 var(--space-1);
  overflow: hidden;
}

/* Status view's 工作空间 tab: one directory row per workspace — folder icon +
   name + root sub-line (the flat session row's two-line geometry). Click
   drafts a session there; the ⋯ hover action opens the same workspace menu
   the grouped header uses. */
.ws-dir {
  display: block;
  padding: 8px calc(var(--sb-pad-x) - var(--sb-inset));
  border-radius: var(--radius-sm);
  cursor: pointer;
  position: relative;
  user-select: none;
}
.ws-dir:hover {
  background: var(--sb-hover, var(--color-hover));
}
/* The active workspace's directory row carries the same neutral selected
   fill as a session row — it reads as "where I am". */
.ws-dir.on {
  background: var(--sb-selected, var(--color-selected));
}
.ws-dir + .ws-dir {
  margin-top: var(--space-05);
}
.ws-dir-row {
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
  min-width: 0;
}
.ws-dir-icon {
  flex: none;
  color: var(--color-text-muted);
}
.ws-dir-name {
  flex: 1;
  min-width: 0;
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-caption);
  line-height: var(--leading-tight);
  color: var(--color-text);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: clip;
  -webkit-mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - 16px), transparent);
  mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - 16px), transparent);
}
.ws-dir-act {
  position: absolute;
  top: 0;
  bottom: 0;
  right: var(--sb-action-inset);
  display: inline-flex;
  align-items: center;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--duration-fast) var(--ease-out),
    visibility 0s linear var(--duration-fast);
}
/* Inline rename input in the directory row — mirrors WorkspaceGroup's
   .gh-rename (accent hairline, page ground). */
.ws-dir-rename {
  flex: 1;
  min-width: 0;
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-caption);
  color: var(--color-text);
  background: var(--color-bg);
  border: 0.5px solid var(--color-accent);
  border-radius: var(--radius-sm);
  padding: 2px 5px;
  outline: none;
}
.ws-dir:hover .ws-dir-act,
.ws-dir:focus-within .ws-dir-act {
  opacity: 1;
  visibility: visible;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.ws-dir-sub {
  margin: var(--space-1) 0 0;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: clip;
  -webkit-mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - 16px), transparent);
  mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - 16px), transparent);
}
/* The hover ⋯ is absolutely positioned over the row's right edge — while it is
   visible, both text lines yield its footprint so no text renders under it.
   (Margin, not padding: these lines clip with overflow:hidden + a fade mask,
   which both measure to the border box — padding would leave the clip edge
   unchanged.) */
.ws-dir:hover .ws-dir-name,
.ws-dir:focus-within .ws-dir-name,
.ws-dir:hover .ws-dir-sub,
.ws-dir:focus-within .ws-dir-sub {
  margin-right: calc(var(--icon-button-sm) + var(--space-2));
}

/* Done tab's grouped variant: the group header mirrors the workspace
   group's .gh geometry (folder icon lands at --sb-pad-x, name aligns with
   the session titles below); click collapses, ⋯ opens the workspace menu. */
.done-gh {
  display: flex;
  align-items: center;
  gap: var(--sb-gap);
  padding: 8px calc(var(--sb-pad-x) - var(--sb-inset));
  border-radius: var(--radius-sm);
  font-family: var(--font-ui);
  color: var(--color-text);
  user-select: none;
  position: relative;
  cursor: pointer;
}
.done-gh:hover {
  background: var(--sb-hover, var(--color-hover));
}
.done-gh-folder {
  flex: none;
  color: var(--color-text-muted);
}
.done-gh-name {
  flex: 1;
  min-width: 0;
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
  color: var(--color-text-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: clip;
  -webkit-mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - 16px), transparent);
  mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - 16px), transparent);
}
.done-gh-count {
  flex: none;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}
.done-gh-act {
  position: absolute;
  top: 0;
  bottom: 0;
  right: var(--sb-action-inset);
  display: inline-flex;
  align-items: center;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--duration-fast) var(--ease-out),
    visibility 0s linear var(--duration-fast);
}
.done-gh:hover .done-gh-act,
.done-gh:focus-within .done-gh-act {
  opacity: 1;
  visibility: visible;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.done-gh:hover .done-gh-count,
.done-gh:focus-within .done-gh-count {
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--duration-fast) var(--ease-out),
    visibility 0s linear var(--duration-fast);
}

/* Sessions — scrolling group list. The top gap to the action rows lives on
   the fixed .sessions-head (which carries the seam); this container keeps the
   side inset and the bottom breathing room. Scrolled content clips at the
   .sessions-head seam. Scrollbar: the thin ::-webkit-scrollbar below; standard
   scrollbar-width would kill it on Chromium (see the global scrollbar block
   in style.css). The custom 4px scrollbar is classic — it reserves layout
   width whenever it shows — so keep its gutter reserved even when the list
   fits: the rows' right edge (and every trailing button's) then stays on one
   line with .sessions-head in both states. */
.sessions {
  flex: 1;
  overflow-y: auto;
  padding: 0 var(--sb-inset) var(--space-3);
  min-height: 0;
  scrollbar-gutter: stable;
}
.sessions::-webkit-scrollbar { width: var(--space-1); }
.sessions::-webkit-scrollbar-track { background: transparent; }
.sessions::-webkit-scrollbar-thumb {
  /* Hidden until the list is scrolled (.scrolling) — an always-visible thumb
     is permanent chrome on a surface that only scrolls occasionally. Neutral,
     text-derived translucency — adapts to both schemes and sits quietly on
     the sidebar surface (no accent tint on hover). */
  background: transparent;
  border-radius: var(--radius-full);
  transition: background var(--duration-base) var(--ease-out);
}
.sessions.scrolling::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text) 12%, transparent);
}
.sessions.scrolling::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--color-text) 25%, transparent);
}

/* Footer — account area (UserMenu) pinned under the session list. */
.side-footer {
  flex: none;
  position: relative;
  z-index: 1;
  padding: var(--space-2) var(--sb-inset);
  border-top: 0.5px solid var(--line);
  background: var(--color-sidebar-bg);
}
.side-footer::before {
  bottom: 100%;
  background:
    linear-gradient(to top, color-mix(in srgb, var(--color-text) 1.5%, transparent), transparent 35%),
    linear-gradient(to top, color-mix(in srgb, var(--color-text) 1%, transparent), transparent 65%),
    linear-gradient(to top, color-mix(in srgb, var(--color-text) 0.75%, transparent), transparent);
  transition-duration: var(--duration-slow);
}
.side-footer--shadowed::before { opacity: 1; }

/* Section label — heads the workspace list below the action buttons. Aligns
   with the rows' leading inset (--sb-pad-x) so it reads as the list's title.
   The right padding is the list's scrollbar track (--space-1, reserved there
   at all times via scrollbar-gutter: stable) plus --sb-action-inset, so the
   section action buttons' right edge lands on the same vertical line as the
   row buttons' — compensating here, not on .sessions-head, keeps the pinned
   section's drop-active frame symmetric. */
.side-section-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 calc(var(--space-1) + var(--sb-action-inset)) var(--space-1) var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-section-label);
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
/* Breathing room between the pinned section and the list label below it —
   matches the label's own padding-bottom (--space-1) so the label sits
   centred in the gap: the same distance to the pinned rows' bottom edge as
   to the first session row's top edge. The resize handle straddles the
   pinned block's bottom edge on its own negative margins and is unaffected. */
.sessions-head .pinned + .side-section-label {
  margin-top: var(--space-1);
}
/* Section actions (collapse-all, display switcher) are always visible — they
   are the only way to reach the flat/grouped switch and group folding. */
.side-section-toggle {
  color: var(--faint);
}
.side-section-toggle:hover {
  color: var(--dim);
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

/* Firefox (the engine without ::-webkit-scrollbar — the same detector the
   global scrollbar block in style.css uses): the global thin scrollbar
   stays — users keep a draggable bar — and its stable gutter is
   browser-owned, so no fixed compensation can ever match it. Instead the
   section label gets the SAME gutter environment (a never-scrolling scroll
   container with the gutter reserved), which the browser sizes identically
   to the list's at any thin width — nothing to measure; the label's right
   padding then drops the Chromium-only --space-1 track compensation. The
   padding/negative-margin pairs reserve the focus ring's spread
   (--p-focus-ring-w) so overflow can't clip it — on top always, and on the
   right only when the font scale shrinks --sb-action-inset below the ring
   (max/min clamp: at medium and up the pair collapses to the plain inset
   and zero margin, so the button's right edge stays on the shared line at
   every scale). No left reserve: the only focusable control sits at the
   label's right end. This block must sit AFTER the base .side-section-label
   rules — their padding shorthand would otherwise undo these overrides.
   Inert on Chromium — desktop (Electron) never takes this branch. */
@supports not selector(::-webkit-scrollbar) {
  .side-section-label {
    overflow: hidden;
    scrollbar-gutter: stable;
    padding-top: var(--p-focus-ring-w);
    margin-top: calc(var(--p-focus-ring-w) * -1);
    padding-right: max(var(--sb-action-inset), var(--p-focus-ring-w));
    margin-right: min(0px, var(--sb-action-inset) - var(--p-focus-ring-w));
  }
  .sessions-head .pinned + .side-section-label {
    margin-top: calc(var(--space-1) - var(--p-focus-ring-w));
  }
}

/* Workspace drag-to-reorder: a line at the top (drop-before) or bottom
   (drop-after) of the group under the cursor marks where the dragged workspace
   will land. Inset shadows avoid layout shift. */
.ws-drop-target.drop-before { box-shadow: inset 0 2px 0 var(--color-accent); }
.ws-drop-target.drop-after { box-shadow: inset 0 -2px 0 var(--color-accent); }

/* Search-dialog locate: the picked workspace's header washes a soft accent
   overlay that fades out — an overlay (not a background animation) so the
   resting fill underneath (hover / the draft-workspace selected fill) never
   gets overridden and nothing snaps when the wash ends (same treatment as
   the settings provider row's pp-flash). The class sits on the wrapper; the
   overlay lives on WorkspaceGroup's .gh, hence :deep. */
.ws-drop-target.ws-locate-flash :deep(.gh) {
  isolation: isolate;
}
.ws-drop-target.ws-locate-flash :deep(.gh)::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: var(--radius-sm);
  background: var(--color-accent-soft);
  pointer-events: none;
  animation: ws-locate-fade var(--duration-flash) var(--ease-out) forwards;
}
@keyframes ws-locate-fade {
  from { opacity: 1; }
  to { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .ws-drop-target.ws-locate-flash :deep(.gh)::before { animation: none; }
}

/* Flat mode: the scroll container is the drag-back-to-unpin target (the whole
   list — every workspace's sessions live here). The accent frame mirrors the
   grouped mode's home-group affordance (1px while the drag is active, 2px on
   hover); inset shadows avoid layout shift. */
.sessions.pinned-drag-active { box-shadow: inset 0 0 0 1px var(--color-accent); }
.sessions.flat-pinned-drop-hover { box-shadow: inset 0 0 0 2px var(--color-accent); }

/* Flat mode's manual pager: a centered, content-width quiet button (icon
   trails the label). */
.show-more-row {
  display: flex;
  align-items: center;
  justify-content: center;
}
.show-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  margin: 0;
  padding: 6px var(--space-3);
  min-width: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  cursor: pointer;
}
.show-more:hover { background: var(--sb-hover, var(--color-hover)); }
.show-more:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.show-more-label {
  flex: none;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Folder-drop affordance: covers the whole column while a folder drag hovers
   (desktop only — folderDropActive can never go true without the preload
   bridge). Visual language mirrors the composer's full-window drop overlay:
   dashed accent card on a dimmed surface. */
.folder-drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-3);
  box-sizing: border-box;
  background: color-mix(in srgb, var(--color-sidebar-bg) 72%, transparent);
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--duration-base) ease,
    visibility var(--duration-base);
}
.folder-drop-overlay.show {
  opacity: 1;
  visibility: visible;
}
.folder-drop-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  max-width: 100%;
  box-sizing: border-box;
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  border: 0.5px dashed var(--color-accent);
  background: var(--color-bg);
  color: var(--color-accent);
  font-size: var(--ui-font-size-lg);
  font-weight: var(--weight-medium);
  box-shadow: var(--shadow-md);
}
.folder-drop-card svg {
  flex: none;
}
.folder-drop-card span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

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
.view-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}
/* View switcher dropdown: a muted group label heads the options; the current
   view's checkmark sits at the row's right edge. */
.view-menu-label {
  padding: var(--space-1) var(--space-2) var(--space-05);
  font-size: var(--text-xs);
  color: var(--faint);
  user-select: none;
}
.view-menu-check {
  margin-left: auto;
  display: inline-flex;
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
:deep(.workspace-rename-item) {
  font-size: var(--text-xs);
  font-weight: var(--weight-option-label);
}

/* Check slot for the section overflow menu — fixed width so unchecked items
   keep their text aligned with the checked one. */
.section-menu-check {
  display: inline-flex;
  flex: none;
  width: 14px;
}

</style>
