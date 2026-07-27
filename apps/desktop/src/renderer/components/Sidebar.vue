<!-- apps/kimi-web/src/components/Sidebar.vue -->
<!-- Unified sidebar: session groups with collapsible workspace headers.
     The old workspace rail and workspace tabs have been removed;
     workspace switching, folding and renaming all live in the group header. -->
<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, onUpdated, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { serverEndpointLabel } from '../api/config';
import {
  fetchDevBackendState,
  initialDevBackendState,
  shortOrigin,
  switchDevBackend,
  type BackendName,
  type DevBackendState,
} from '../api/devBackend';
import { copyTextToClipboard } from '../lib/clipboard';
import {
  loadCollapsedWorkspaces,
  saveCollapsedWorkspaces,
} from '../lib/storage';
import { moveInOrder, type DropPosition, type WorkspaceSortMode } from '../lib/workspaceOrder';
import {
  canDropWorkspaceFolders,
  extractDroppedFolderPaths,
  looksLikeFolderDrag,
} from '../lib/nativeWorkspaceDrop';
import type { Session, WorkspaceGroup as WorkspaceGroupType, WorkspaceView } from '../types';
import SearchSessionsDialog from './dialogs/SearchSessionsDialog.vue';
import UpdateIndicator from './UpdateIndicator.vue';
import WorkspaceGroup from './WorkspaceGroup.vue';
import PinnedSessionList from './PinnedSessionList.vue';
import { isDesktop, isMacosDesktop } from '../lib/desktopFlag';
import { useVibrancy } from '../composables/useVibrancy';
import { resolvedBindingKeys } from '../composables/useShortcuts';
import { track } from '../lib/track';
import { Badge, Icon, IconButton, Kbd, Menu, MenuItem, Pill } from '@moonshot-ai/web-ui';

const { t } = useI18n();

// Frosted-sidebar (vibrancy) preference — the tint paint below only applies
// while on; traffic-light layout keeps keying off macos-desktop.
const { vibrancy } = useVibrancy();

// Dev-only affordance: when the page is served by the Vite dev server, a
// backend pill next to the brand shows the engine generation reported by
// /meta (v1 = older server binary, v2 = kap-server) plus the endpoint the dev
// proxy forwards to — click it to switch presets without restarting Vite. In
// production this is all inert.
const isDev = import.meta.env.DEV;
const isProd = import.meta.env.PROD;
const devBackend = ref<DevBackendState | null>(isDev ? initialDevBackendState() : null);
if (isDev) {
  onMounted(async () => {
    const live = await fetchDevBackendState();
    if (live) devBackend.value = live;
  });
}
// host:port of the server the dev proxy currently forwards to (fallback: the
// build-time label when the dev endpoints are unavailable).
const endpoint = computed(() => {
  if (!isDev) return '';
  const current = devBackend.value?.current;
  return current ? shortOrigin(current) : serverEndpointLabel();
});
const backendNames: BackendName[] = ['default', 'multi'];
function presetUrl(name: BackendName): string {
  const url = devBackend.value?.presets[name] ?? '';
  return url ? shortOrigin(url) : '';
}
function isCurrentBackend(name: BackendName): boolean {
  const state = devBackend.value;
  return state !== null && state.current === state.presets[name];
}

const props = withDefaults(
  defineProps<{
    activeWorkspace: WorkspaceView | null;
    activeWorkspaceId: string | null;
    sessions: Session[];
    groups: WorkspaceGroupType[];
    /** Pinned sessions (across workspaces, manual order) — rendered in the
     *  pinned section above all workspace groups; empty hides the section. */
    pinnedSessions?: Session[];
    activeId: string;
    /** Current workspace sort mode — drives the section-header sort button. */
    workspaceSortMode: WorkspaceSortMode;
    /** Backend engine generation from /meta — dev-only badge next to the brand. */
    backend?: 'v1' | 'v2';
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
    pinnedSessions: () => [],
    backend: 'v1',
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
  archive: [id: string];
  fork: [id: string];
  export: [id: string];
  pin: [id: string];
  reorderPinned: [ids: string[]];
  pinAt: [id: string, targetId: string | null, position: DropPosition];
  unpin: [id: string];
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
// Keycap hints follow the user's actual bindings (desktop-only customizable
// shortcuts, lib/keymap.ts); empty array = unassigned → no caps rendered.
const sessionSearchKeys = computed(() => resolvedBindingKeys('searchSessions'));
const newChatKeys = computed(() => resolvedBindingKeys('newSession'));

function openSearch(): void {
  // Sessions are loaded per-workspace (first page only); lazily drain the rest
  // so the dialog's client-side filter covers everything.
  emit('loadAllSessions');
  showSearch.value = true;
}

// Popup-style shortcuts toggle: the same binding that opens also closes.
function toggleSearch(): void {
  if (showSearch.value) {
    showSearch.value = false;
  } else {
    openSearch();
  }
}

// The header search button is the 'button'-sourced entry of the searchSessions
// action (shortcut/menu entries are attributed in App.vue's dispatcher).
function onSearchButtonClick(): void {
  track('action_invoked', { action: 'searchSessions', source: 'button' });
  openSearch();
}

// App.vue's shortcut dispatcher drives the dialog through these exposes
// (isSearchOpen lets it allow the closing press through the overlay guard).
defineExpose({ openSearch, toggleSearch, isSearchOpen: () => showSearch.value });

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
// In-group expand / collapse (show-more pagination)
// ---------------------------------------------------------------------------
// Tracks which workspace groups are "expanded" past their first page. Ephemeral
// (not persisted): a refresh reloads only the first page, so everything starts
// collapsed. Loading more expands automatically; the user can collapse back to
// the first page without losing the already-loaded data.
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

function onLoadMore(id: string): void {
  // Loading more should reveal the new rows immediately.
  if (!expandedIds.value.has(id)) {
    const next = new Set(expandedIds.value);
    next.add(id);
    expandedIds.value = next;
  }
  emit('loadMoreSessions', id);
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

// ---------------------------------------------------------------------------
// Workspace section overflow menu (the ⋯ in the WORKSPACES header). Holds the
// sort mode and the "show paths" toggle as text items with a check mark for the
// active one. Anchored to the trigger via position:fixed so the scrolling list
// can't clip it.
// ---------------------------------------------------------------------------
const sectionMenuOpen = ref(false);
const sectionMenuStyle = ref<Record<string, string>>({});
const sectionMenuRef = ref<InstanceType<typeof Menu> | null>(null);

function onSectionMenuDocClick(e: MouseEvent): void {
  const target = e.target as Element;
  if (target.closest('.side-section-kebab') || target.closest('.section-menu')) return;
  closeSectionMenu();
}

async function toggleSectionMenu(e: MouseEvent): Promise<void> {
  if (sectionMenuOpen.value) {
    closeSectionMenu();
    return;
  }
  const btn = e.currentTarget as HTMLElement;
  sectionMenuOpen.value = true;
  document.addEventListener('mousedown', onSectionMenuDocClick);
  window.addEventListener('resize', closeSectionMenu);
  await nextTick();
  const menu = sectionMenuRef.value?.el;
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
  sectionMenuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
  };
}

function closeSectionMenu(): void {
  sectionMenuOpen.value = false;
  document.removeEventListener('mousedown', onSectionMenuDocClick);
  window.removeEventListener('resize', closeSectionMenu);
}

function chooseSortMode(mode: WorkspaceSortMode): void {
  emit('setWorkspaceSortMode', mode);
  closeSectionMenu();
}

// ---------------------------------------------------------------------------
// Dev backend switcher menu (the pill next to the brand). Dev-only: repoints
// the Vite dev proxy at the other engine, then reloads so every client state
// (REST, WS, /meta) re-initializes against the new backend.
// ---------------------------------------------------------------------------
const backendMenuOpen = ref(false);
const backendMenuStyle = ref<Record<string, string>>({});
const backendMenuRef = ref<InstanceType<typeof Menu> | null>(null);

function onBackendMenuDocClick(e: MouseEvent): void {
  const target = e.target as Element;
  if (target.closest('.ch-backend') || target.closest('.backend-menu')) return;
  closeBackendMenu();
}

async function toggleBackendMenu(e: MouseEvent): Promise<void> {
  if (devBackend.value === null) return;
  if (backendMenuOpen.value) {
    closeBackendMenu();
    return;
  }
  const btn = e.currentTarget as HTMLElement;
  backendMenuOpen.value = true;
  document.addEventListener('mousedown', onBackendMenuDocClick);
  window.addEventListener('resize', closeBackendMenu);
  await nextTick();
  const menu = backendMenuRef.value?.el;
  const r = btn.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const menuH = menu?.offsetHeight ?? 0;
  let top = r.bottom + gap;
  if (top + menuH > window.innerHeight - margin) {
    top = Math.max(margin, r.top - menuH - gap);
  }
  backendMenuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(Math.max(margin, r.left))}px`,
  };
}

function closeBackendMenu(): void {
  backendMenuOpen.value = false;
  document.removeEventListener('mousedown', onBackendMenuDocClick);
  window.removeEventListener('resize', closeBackendMenu);
}

async function chooseBackend(name: BackendName): Promise<void> {
  if (isCurrentBackend(name)) {
    closeBackendMenu();
    return;
  }
  const next = await switchDevBackend(name);
  if (next === null) {
    console.warn('[kimi-code] dev backend switch failed:', name);
    closeBackendMenu();
    return;
  }
  // Full reload: every client channel (REST base state, WS, /meta) must
  // re-initialize against the new backend — a soft swap would leave stale
  // session streams subscribed through the old target.
  window.location.reload();
}

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onGhMenuDocClick, true);
  document.removeEventListener('mousedown', onWsMenuDocClick);
  document.removeEventListener('mousedown', onSectionMenuDocClick);
  document.removeEventListener('mousedown', onBackendMenuDocClick);
  window.removeEventListener('resize', closeWsMenu);
  window.removeEventListener('resize', closeSectionMenu);
  window.removeEventListener('resize', closeBackendMenu);
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
    :class="{ 'macos-desktop': isMacosDesktop, vibrancy, collapsed, 'no-anim': dragging }"
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
            <!-- Brand mark: the robot mascot (transparent background, no tile).
                 The .ch-eyes/.ch-eye classes hook the shared idle look/blink
                 keyframes in style.css; the viewBox stays ~32 wide so those
                 px-based transforms keep their old proportions. -->
            <!-- brand-mark:start — generated by scripts/build-brand-icons.mjs from
                 KIMI CODE LOGO/Original Logo.svg; do not edit by hand -->
            <svg ref="logoRef" class="ch-logo" viewBox="0 0 32 28.2791" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Kimi Code" @click="onLogoClick" @pointerdown="onLogoPointerDown" @pointerup="onLogoPointerUp" @pointercancel="onLogoPointerUp">
              <defs>
                <radialGradient id="chLogoFace" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(14.5195 12.5993) scale(14.1117)">
                  <stop stop-color="#117DFB" />
                  <stop offset="0.759254" stop-color="#449BFF" />
                  <stop offset="1" stop-color="#77B6FF" />
                </radialGradient>
              </defs>
              <path d="M 14.5195 0.3556 C 22.2186 0.3556 28.4601 6.5969 28.4601 14.2961 C 28.4601 21.9952 22.2186 28.2366 14.5195 28.2366 C 6.8204 28.2366 0.579 21.9952 0.579 14.2961 C 0.579 6.5969 6.8204 0.3556 14.5195 0.3556 Z" fill="#2389FF" />
              <path d="M 14.5195 0.3556 C 22.2186 0.3556 28.4601 6.5969 28.4601 14.2961 C 28.4601 21.9952 22.2186 28.2366 14.5195 28.2366 C 6.8204 28.2366 0.579 21.9952 0.579 14.2961 C 0.579 6.5969 6.8204 0.3556 14.5195 0.3556 Z" fill="url(#chLogoFace)" />
              <g class="ch-eyes" fill="#fff">
                <path class="ch-eye" d="M 12.8637 8.8339 C 12.7301 7.8611 13.4042 6.965 14.3693 6.8324 C 15.3344 6.6999 16.2251 7.3811 16.3587 8.3539 L 16.7656 11.3165 C 16.8992 12.2893 16.2251 13.1854 15.26 13.318 C 14.2949 13.4505 13.4042 12.7693 13.2706 11.7965 L 12.8637 8.8339 Z" />
                <path class="ch-eye" d="M 20.1974 7.8996 C 20.0705 6.9754 20.6717 6.1295 21.5403 6.0102 C 22.4089 5.8909 23.216 6.5434 23.3429 7.4676 L 23.7295 10.282 C 23.8564 11.2062 23.2551 12.0521 22.3865 12.1714 C 21.5179 12.2907 20.7109 11.6382 20.5839 10.714 L 20.1974 7.8996 Z" />
              </g>
              <rect x="0" y="17.8221" width="31.9124" height="10.4405" rx="1.158" fill="#002E58" />
              <path d="M 2.6265 21.0396 L 5.5577 22.7318 C 5.7989 22.8711 5.7989 23.2193 5.5577 23.3586 L 2.6265 25.0509" stroke="#fff" stroke-width="1.3133" stroke-linecap="round" />
              <path d="M 8.7332 25.439 H 11.6282" stroke="#007CFF" stroke-width="1.3133" stroke-linecap="round" />
              <path d="M 28.9734 0 C 30.2364 0 31.2604 1.0239 31.2604 2.287 C 31.2604 3.55 30.2364 4.574 28.9734 4.574 L 26.9555 4.574 C 26.8068 4.574 26.6864 4.4535 26.6864 4.3049 L 26.6864 2.287 C 26.6864 1.0239 27.7103 0 28.9734 0 Z" fill="#1783FF" />
            </svg>
            <!-- brand-mark:end -->
            <span class="ch-name">Kimi Code</span>
            <Pill
              v-if="isDev"
              class="ch-backend"
              :clickable="devBackend !== null"
              :title="t('sidebar.backendTitle', { backend, endpoint })"
              @click="toggleBackendMenu"
            >
              <span class="ch-backend-kind" :class="`is-${backend}`">{{ backend }}</span>
              <span class="ch-backend-ep"> · {{ endpoint }}</span>
              <Icon v-if="devBackend !== null" name="chevron-down" size="sm" />
            </Pill>
          </template>
        </div>
        <div class="ch-tail">
          <IconButton
            v-if="!isMacosDesktop"
            class="ch-collapse"
            size="sm"
            :label="t('sidebar.collapseSidebar')"
            @click.stop="emit('collapse')"
          >
            <Icon name="panel-collapse" />
          </IconButton>
          <!-- Auto-update pill (desktop only): rightmost in the header; renders
               nothing unless the main process reports an update state, so the
               web build stays untouched. -->
          <UpdateIndicator />
        </div>
      </div>

      <!-- Sidebar actions share one container so New chat and Search are true
           sibling controls. The optional workspace action occupies column 2. -->
      <div
        class="sidebar-actions"
        :class="{
          'sidebar-actions--scrolled': sessionsScrolled,
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
        <button class="search" type="button" @click="onSearchButtonClick">
          <Icon class="search-icon" name="search" />
          <span class="search-input">{{ t('sidebar.search') }}</span>
          <Kbd :keys="sessionSearchKeys" />
        </button>
      </div>

      <!-- Session list — grouped by workspace -->
      <div ref="sessionsEl" class="sessions" :class="{ scrolling: sessionsScrolling }" @scroll="onSessionsScroll">
        <!-- Empty state — only when no workspace is registered at all; empty
             workspaces still render their group header (with the + button). -->
        <div v-if="groups.length === 0" class="empty">
          {{ t('workspace.noWorkspace') }}
        </div>

        <template v-else>
          <!-- Pinned section: above every workspace caption, listing pinned
               sessions across all workspaces. Hidden when nothing is pinned. -->
          <PinnedSessionList
            v-if="pinnedSessions.length > 0"
            :sessions="pinnedSessions"
            :active-id="activeId"
            :pending-by-session="pendingBySession"
            :unread-by-session="unreadBySession"
            @select-session="onSelectSession"
            @rename-session="(id, title) => emit('rename', id, title)"
            @archive-session="(id) => emit('archive', id)"
            @fork-session="(id) => emit('fork', id)"
            @export-session="(id) => emit('export', id)"
            @pin-session="(id) => emit('pin', id)"
            @pin-session-at="(id, targetId, position) => emit('pinAt', id, targetId, position)"
            @session-drag-start="onPinnedSessionDragStart"
            @session-drag-end="onPinnedSessionDragEnd"
            @reorder="(ids) => emit('reorderPinned', ids)"
          />
          <div class="side-section-label">
            <span class="side-section-title">{{ t('sidebar.workspaces') }}</span>
            <div class="side-section-actions">
              <IconButton
                class="side-section-toggle"
                size="sm"
                :label="allCollapsed ? t('sidebar.expandAll') : t('sidebar.collapseAll')"
                @click.stop="allCollapsed ? expandAllWorkspaces() : collapseAllWorkspaces()"
              >
                <Icon v-if="allCollapsed" name="expand" />
                <Icon v-else name="collapse" />
              </IconButton>
              <IconButton
                class="side-section-toggle side-section-kebab"
                size="sm"
                :label="t('sidebar.options')"
                aria-haspopup="menu"
                :aria-expanded="sectionMenuOpen"
                @click.stop="toggleSectionMenu($event)"
              >
                <Icon name="dots-horizontal" />
              </IconButton>
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
              :is-expanded="isExpanded"
              :pinned-drag-session="pinnedDragSession"
              @group-click="handleGhClick"
              @group-contextmenu="openGhMenu"
              @toggle-ws-menu="toggleWsMenu"
              @create-in-workspace="(id) => emit('createInWorkspace', id)"
              @select-session="onSelectSession"
              @rename-session="(id, title) => emit('rename', id, title)"
              @archive-session="(id) => emit('archive', id)"
              @fork-session="(id) => emit('fork', id)"
              @export-session="(id) => emit('export', id)"
              @pin-session="(id) => emit('pin', id)"
              @drop-pinned-session="onDropPinnedSession"
              @load-more="onLoadMore"
              @toggle-expand="toggleExpand"
              @confirm-rename="confirmRenameWorkspace"
              @cancel-rename="cancelRenameWorkspace"
              @update-rename-value="onUpdateRenameValue"
              @ws-dragstart="onWsDragstart"
              @ws-dragend="onWsDragend"
            />
          </div>
        </template>
      </div>

      <!-- Footer: settings entry pinned under the session list -->
      <div class="side-footer" :class="{ 'side-footer--shadowed': sessionsCanScrollDown }">
        <button class="btn-settings" type="button" @click.stop="emit('openSettings')">
          <Icon name="settings" />
          <span class="btn-settings-label">{{ t('settings.title') }}</span>
          <Badge v-if="isDesktop && isProd" class="btn-settings-badge" variant="warning" size="sm">{{ t('settings.internalTest') }}</Badge>
        </button>
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
    <!-- Workspace sort menu (position:fixed, anchored to the sort button) -->
    <Menu
      v-if="sectionMenuOpen"
      ref="sectionMenuRef"
      class="section-menu"
      :style="sectionMenuStyle"
      @click.stop
    >
      <MenuItem @click="chooseSortMode('manual')">
        <span class="section-menu-check">
          <Icon v-if="workspaceSortMode === 'manual'" name="check" size="sm" />
        </span>
        {{ t('sidebar.sortManual') }}
      </MenuItem>
      <MenuItem @click="chooseSortMode('recent')">
        <span class="section-menu-check">
          <Icon v-if="workspaceSortMode === 'recent'" name="check" size="sm" />
        </span>
        {{ t('sidebar.sortRecent') }}
      </MenuItem>
    </Menu>
    <!-- Dev backend switcher menu (position:fixed, anchored to the brand pill) -->
    <Menu
      v-if="backendMenuOpen"
      ref="backendMenuRef"
      class="backend-menu"
      :style="backendMenuStyle"
      @click.stop
    >
      <MenuItem v-for="name in backendNames" :key="name" @click="chooseBackend(name)">
        <span class="section-menu-check">
          <Icon v-if="isCurrentBackend(name)" name="check" size="sm" />
        </span>
        <span class="backend-menu-name">{{ name }}</span>
        <span class="backend-menu-url">{{ presetUrl(name) }}</span>
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
     - row titles start at --sb-pad-x + --sb-gutter + --sb-gap. */
  --sb-inset: var(--space-2);  /* row box inset from the sidebar edge */
  --sb-pad-x: var(--space-4);  /* content start x (inset + row padding) */
  --sb-gutter: 16px;           /* leading icon slot (matches the 16px folder icon, so the session title aligns under the workspace name) */
  --sb-gap: var(--space-2);    /* gap between the icon slot and the text */
  /* Row hover wash — global --color-hover (lighter than the selected fill;
     both translucent, so they sit on any surface). */
  --sb-hover: var(--color-hover);
  --sb-selected: color-mix(in srgb, var(--color-selected) 75%, transparent);
}
/* macOS desktop + frosted material on: frosted sidebar — the column paints
   ONLY the translucent --color-sidebar-tint wash, which presses the window's
   native vibrancy material (NSVisualEffectView 'menu', pinned to
   visualEffectState 'inactive' — set in src/main/window.ts) one step darker
   in dark mode / one step brighter in light mode. Every sub-surface that
   normally re-paints the sidebar surface (header, footer) stays transparent
   so the tint reads as one uniform pane; the .col hairline still separates
   it from the conversation pane. The `vibrancy` class is the settings switch
   (composables/useVibrancy.ts): off = plain --color-sidebar-bg again. */
.side.macos-desktop.vibrancy { background: var(--color-sidebar-tint, transparent); }
.side.macos-desktop.vibrancy .ch,
.side.macos-desktop.vibrancy .sidebar-actions,
.side.macos-desktop.vibrancy .side-footer {
  background: transparent;
}
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
  /* The mascot is near-square (32×28.914 viewBox); let the width follow the
     fixed height instead of pinning the old wide-mark 32px. */
  width: auto;
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
/* Dev-only backend pill next to the brand: shows the engine generation from
   /meta (v1 / v2) and opens the dev-proxy preset switcher menu. v2 is
   accent-colored so it reads differently at a glance. */
.ch-backend {
  flex: none;
  min-width: 0;
  font-family: var(--font-ui);
}
.ch-backend-kind {
  font-family: inherit;
  font-weight: 500;
  color: var(--color-text-muted);
}
.ch-backend-kind.is-v2 {
  color: var(--color-accent);
}
.ch-backend-ep {
  font-family: inherit;
  color: var(--color-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Responsive brand row: below 320px the pill's endpoint drops out (the v1/v2
   kind + chevron stay — the full target is one tooltip away); below 250px the
   product name also drops out so the logo and action buttons keep their room. */
@container sidebar-col (max-width: 320px) {
  .ch-backend-ep { display: none; }
}
@container sidebar-col (max-width: 250px) {
  .ch-name { display: none; }
}

/* New chat and Search are direct siblings in one action group. The grid keeps
   the optional workspace action beside New chat while Search spans both
   columns on the next row. The group also owns the scroll-linked list seam. */
.sidebar-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0 var(--space-2);
  padding: 0 var(--sb-inset) var(--space-1);
  position: relative;
  z-index: 1;
  background: var(--color-sidebar-bg);
  border-bottom: 0.5px solid transparent;
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.sidebar-actions::after,
.side-footer::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 13px;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}
.sidebar-actions::after {
  top: 100%;
  background:
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1.5%, transparent), transparent 35%),
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1%, transparent), transparent 65%),
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 0.75%, transparent), transparent);
  transition-duration: var(--duration-slow);
}
.sidebar-actions--scrolled {
  border-bottom-color: var(--line);
}
.sidebar-actions--scrolled::after { opacity: 1; }
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

/* Sessions — owns the vertical padding around the list (the 12px gap to the
   search row above and the bottom breathing room). Scrolled content passes
   through the top padding and clips at the .sidebar-actions seam. Scrollbar: the
   4px ::-webkit-scrollbar below; standard scrollbar-width would kill it on
   Chromium (see the global scrollbar block in style.css). */
.sessions {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-3) var(--sb-inset);
  min-height: 0;
}
.sessions::-webkit-scrollbar { width: 4px; }
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

/* Footer — settings entry pinned under the session list. Same list-style
   control family as search / New chat (full-width, left-aligned, hover
   sunken — not a Button). */
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
.btn-settings {
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
.btn-settings:hover { background: var(--sb-hover); }
.btn-settings:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.btn-settings svg { flex: none; }
.btn-settings-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.btn-settings-badge {
  margin-left: var(--space-2);
  flex: none;
}

/* Section label — heads the workspace list below the action buttons. Aligns
   with the rows' leading inset (--sb-pad-x) so it reads as the list's title. */
.side-section-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 var(--space-3) var(--space-1) var(--space-2);
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
.section-menu,
.backend-menu {
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

/* Backend switcher menu rows: mono engine name + muted preset URL. */
.backend-menu-name {
  font-family: var(--mono);
  font-weight: 500;
}
.backend-menu-url {
  margin-left: 8px;
  font-family: var(--mono);
  color: var(--color-text-muted);
}

</style>
