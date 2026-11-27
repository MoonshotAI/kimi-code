<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import '../lib/anchored-menu.css';
import type { PinnedEntry, WorkspaceView } from '@moonshot-ai/app-core/client/types';
import {
  copyTextToClipboard,
  followUiPreferences,
  loadCollapsedWorkspaces,
  loadSessionsSectionCollapsed,
  loadSidebarViewMode,
  pinnedSessionKey,
  pinnedWorkspaceKey,
  saveCollapsedWorkspaces,
  savePinnedCollapsed,
  saveSessionsSectionCollapsed,
  saveSidebarViewMode,
  UI_PREFERENCE_KEYS,
  visibleOpenGroups,
  type DropPosition,
  type PinnedInsertTarget,
  type SidebarViewMode,
  type WorkspaceSortMode,
} from '@moonshot-ai/app-core/lib';
import { useSidebarTabs, useAppearance } from '@moonshot-ai/app-core/composables';
import { SESSIONS_EXPAND_BATCH, useKimiWebClient } from '@moonshot-ai/app-client/client';
import { hostsStore, sessionViewsStore, sessionsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import WorkspaceIcon from '../WorkspaceIcon.vue';
import { track } from '@moonshot-ai/app-client/contracts';
import { Icon, IconButton, Menu, MenuItem, Tooltip, useOverlayScrollbar } from '@moonshot-ai/app-ui';
import PinnedSessionList from '../PinnedSessionList.vue';
import SessionRow from '../SessionRow.vue';
import WorkspaceGroup from '../WorkspaceGroup.vue';
import WorkspaceMenu from './WorkspaceMenu.vue';
import WorkspaceDirectory from './WorkspaceDirectory.vue';
import WorkspaceHoverCard from './WorkspaceHoverCard.vue';
import SidebarSectionHeader from './SidebarSectionHeader.vue';
import { useWorkspaceHoverCard } from './useWorkspaceHoverCard';
import { useWorkspaceRename } from './useWorkspaceRename';
import {
  EMPTY_GROUP_RECORD,
  createGroupScopedRecords,
  scopedActiveSessionId,
  workspaceIdsContainingSession,
} from './groupScopedProps';
import { useSessionDrag, usePinnedReturnTarget, useWorkspaceReorder } from '../composables/useSessionDrag';
import { useAnchoredMenu } from '../composables/useAnchoredMenu';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    statusTab: 'open' | 'done' | 'workspaces';
    canEditWorkspace?: boolean;
    workspaceHoverEnabled?: boolean;
    canOpenWorkspaceDirectory?: boolean;
  }>(),
  { canEditWorkspace: false, workspaceHoverEnabled: false, canOpenWorkspaceDirectory: false },
);

const emit = defineEmits<{
  select: [sessionId: string];
  createInWorkspace: [workspaceId: string];
  addWorkspace: [];
  editWorkspace: [workspace: WorkspaceView];
  generateTitle: [id: string, done: (title: string | null) => void];
  deleteWorkspace: [id: string];
  openWorkspaceDirectory: [path: string];
  'update:statusTab': [tab: 'open' | 'done' | 'workspaces'];
}>();

const client = useKimiWebClient();
const sessionViews = sessionViewsStore();
const workspaces = workspacesStore();
const sessionStore = sessionsStore();

const allGroups = computed(() => sessionViews.workspaceGroups);
const groups = computed(() => sessionViews.unpinnedWorkspaceGroups);
const pinnedWorkspaceGroups = computed(() => sessionViews.pinnedWorkspaceGroups);
const pinnedSessions = computed(() => sessionViews.pinnedSessions);
const pinnedWorkspaceIds = computed(() => workspaces.pinnedWorkspaceIds);
const pinnedWorkspaceIdsSet = computed(() => new Set(pinnedWorkspaceIds.value));
const pinnedEntries = computed<PinnedEntry[]>(() => {
  if (sessionViews.pinnedEntries) return sessionViews.pinnedEntries;
  return [
    ...pinnedWorkspaceGroups.value.map((group) => ({
      key: pinnedWorkspaceKey(group.workspace.id),
      kind: 'workspace' as const,
      group,
    })),
    ...pinnedSessions.value.map((session) => ({
      key: pinnedSessionKey(session.id),
      kind: 'session' as const,
      session,
    })),
  ];
});
const pendingBySession = computed(() => sessionViews.pendingBySession);
const unreadBySession = computed(() => sessionViews.unreadBySession);
const activeWorkspaceId = computed(() => workspaces.activeWorkspaceId);
const workspaceSortMode = computed(() => workspaces.workspaceSortMode);
const activeId = computed(() => sessionStore.activeSessionId ?? '');
const flatSessions = computed(() => {
  if (client.sidebarFlatSessions) return client.sidebarFlatSessions.value;
  const pinned = new Set(workspaces.pinnedWorkspaceIds);
  return client.flatSessions.value.filter((session) => !pinned.has(session.workspaceId ?? ''));
});
const flatHasMore = computed(() =>
  client.sidebarFlatSessionsHasMore
    ? client.sidebarFlatSessionsHasMore.value
    : client.flatSessionsHasMore.value,
);
const flatLoadingMore = client.flatSessionsLoadingMore;
function loadMoreSidebarFlat(): void {
  if (client.loadMoreSidebarFlatSessions) client.loadMoreSidebarFlatSessions();
  else void client.loadMoreFlatSessions();
}
const doneSessions = client.doneSessions;
const doneHasMore = client.doneSessionsHasMore;
const doneLoadingMore = client.doneSessionsLoadingMore;
const initialized = client.initialized;

const {
  workspace: hoverWorkspace,
  cardStyle: hoverCardStyle,
  scheduleOpen: scheduleWorkspaceHoverOpen,
  cancelClose: cancelWorkspaceHoverClose,
  scheduleClose: scheduleWorkspaceHoverClose,
  close: closeWorkspaceHover,
} = useWorkspaceHoverCard();

function onWorkspaceHoverStart(workspace: WorkspaceView, anchor: { right: number; top: number }): void {
  if (props.workspaceHoverEnabled) scheduleWorkspaceHoverOpen(workspace, anchor);
}

function onWorkspaceHoverMouseEnter(workspace: WorkspaceView, event: MouseEvent): void {
  if (!props.workspaceHoverEnabled || wsMenuOpenId.value !== null || renamingId.value === workspace.id) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  onWorkspaceHoverStart(workspace, { right: rect.right, top: rect.top });
}

watch(() => props.workspaceHoverEnabled, (enabled) => {
  if (!enabled) closeWorkspaceHover();
});

const { sidebarTabs } = useSidebarTabs();

const sessionsEl = ref<HTMLElement | null>(null);
const sessionsScrolled = ref(false);
const sessionsCanScrollDown = ref(false);
const {
  thumb: sessionsThumb,
  thumbVisible: sessionsThumbVisible,
  scrolling: sessionsScrolling,
  update: updateSessionsThumb,
  markScrolling: markSessionsScrolling,
  onThumbPointerDown: onSessionsThumbPointerDown,
  onListMouseEnter: onSessionsListMouseEnter,
  onListMouseLeave: onSessionsListMouseLeave,
  onThumbMouseEnter: onSessionsThumbMouseEnter,
  onThumbMouseLeave: onSessionsThumbMouseLeave,
} = useOverlayScrollbar(sessionsEl);

const sessionsCollapsed = ref(loadSessionsSectionCollapsed());

function updateSessionsScrollState(el = sessionsEl.value): void {
  if (!el) return;
  if (sessionsCollapsed.value) {
    sessionsScrolled.value = false;
    sessionsCanScrollDown.value = false;
    updateSessionsThumb();
    return;
  }
  sessionsScrolled.value = el.scrollTop > 0;
  sessionsCanScrollDown.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  updateSessionsThumb();
}

function onSessionsScroll(e: Event): void {
  updateSessionsScrollState(e.target as HTMLElement);
  markSessionsScrolling();
  closeWorkspaceHover();
}

let sessionsResizeObserver: ResizeObserver | null = null;
onMounted(() => {
  nextTick(() => {
    updateSessionsScrollState();
    if (typeof ResizeObserver === 'function' && sessionsEl.value) {
      sessionsResizeObserver = new ResizeObserver(scheduleSessionsScrollState);
      sessionsResizeObserver.observe(sessionsEl.value);
    }
  });
});
let sessionsScrollStateFrame = 0;
function scheduleSessionsScrollState(): void {
  if (sessionsScrollStateFrame) return;
  sessionsScrollStateFrame = requestAnimationFrame(() => {
    sessionsScrollStateFrame = 0;
    updateSessionsScrollState();
  });
}
onUpdated(scheduleSessionsScrollState);
const { fontScale } = useAppearance();
watch(fontScale, () => void nextTick(() => updateSessionsScrollState()));
onBeforeUnmount(() => {
  if (sessionsScrollStateFrame) cancelAnimationFrame(sessionsScrollStateFrame);
  sessionsResizeObserver?.disconnect();
  if (flashWsTimer) clearTimeout(flashWsTimer);
  if (flashSessionTimer) clearTimeout(flashSessionTimer);
});

function setSessionsCollapsed(next: boolean): void {
  if (sessionsCollapsed.value === next) return;
  sessionsCollapsed.value = next;
  saveSessionsSectionCollapsed(next);
  if (next) {
    closeWorkspaceHover();
    cancelRenameWorkspace();
  }
  updateSessionsScrollState();
}

function toggleSessionsCollapsed(): void {
  setSessionsCollapsed(!sessionsCollapsed.value);
}

watch(() => props.statusTab, () => setSessionsCollapsed(false));

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
  setSessionsCollapsed(false);
  const next = new Set(allGroups.value.map((g) => g.workspace.id));
  collapsedIds.value = next;
  saveCollapsedWorkspaces(next);
}

function expandAllWorkspaces(): void {
  setSessionsCollapsed(false);
  const next = new Set<string>();
  collapsedIds.value = next;
  saveCollapsedWorkspaces(next);
}

const allCollapsed = computed(
  () =>
    allGroups.value.length > 0 &&
    allGroups.value.every((g) => collapsedIds.value.has(g.workspace.id)),
);

const visibleLimits = ref<Map<string, number>>(new Map());

function visibleLimit(id: string): number | undefined {
  return visibleLimits.value.get(id);
}

function onExpand(id: string): void {
  const group = allGroups.value.find((g) => g.workspace.id === id);
  if (!group) return;
  const next = (visibleLimits.value.get(id) ?? group.initialCount) + SESSIONS_EXPAND_BATCH;
  const limits = new Map(visibleLimits.value);
  limits.set(id, next);
  visibleLimits.value = limits;
  if (group.sessions.length < next && group.hasMore) {
    void client.loadMoreSessions(id);
  }
}

function onCollapse(id: string): void {
  if (!visibleLimits.value.has(id)) return;
  const limits = new Map(visibleLimits.value);
  limits.delete(id);
  visibleLimits.value = limits;
}

const {
  pinnedDragSession,
  workspaceDragId,
  workspaceDragOver: dragOver,
  startSessionRowDrag,
} = useSessionDrag();

const { onDragOver: onGroupDragOver, onDrop: onGroupDrop } = useWorkspaceReorder({
  getOrder: () => allGroups.value.map((g) => g.workspace.id),
  onReorder: (next) => void client.reorderWorkspaces(next),
  enabled: () =>
    workspaceSortMode.value === 'manual' &&
    !pinnedWorkspaceIdsSet.value.has(workspaceDragId.value ?? ''),
});

function onDropPinnedSession(id: string): void {
  client.unpinSession(id);
}

const listMode = ref<SidebarViewMode>(loadSidebarViewMode());
onBeforeUnmount(
  followUiPreferences(
    [
      UI_PREFERENCE_KEYS.sidebarSessionsSectionCollapsed,
      UI_PREFERENCE_KEYS.sidebarCollapsedWorkspaces,
      UI_PREFERENCE_KEYS.sidebarViewMode,
    ],
    () => {
      sessionsCollapsed.value = loadSessionsSectionCollapsed();
      collapsedIds.value = new Set(loadCollapsedWorkspaces());
      listMode.value = loadSidebarViewMode();
    },
  ),
);

const sectionHeaderTitle = computed(() =>
  props.statusTab === 'workspaces'
    ? t('sidebar.tabWorkspaces')
    : props.statusTab === 'done'
      ? t('sidebar.tabDone')
      : listMode.value === 'grouped'
        ? t('sidebar.workspaces')
        : t('sidebar.sessionsHeader'),
);

const sectionFoldLabel = computed(() => {
  const isProjects =
    props.statusTab === 'workspaces' || (props.statusTab !== 'done' && listMode.value === 'grouped');
  if (isProjects) {
    return sessionsCollapsed.value
      ? t('sidebar.expandProjectsSection')
      : t('sidebar.collapseProjectsSection');
  }
  return sessionsCollapsed.value
    ? t('sidebar.expandSessionsSection')
    : t('sidebar.collapseSessionsSection');
});

function setListMode(mode: SidebarViewMode): void {
  setSessionsCollapsed(false);
  if (listMode.value === mode) return;
  listMode.value = mode;
  saveSidebarViewMode(mode);
}

function visibleGroupRowIds(group: (typeof groups.value)[number]): string[] {
  const cap = visibleLimit(group.workspace.id) ?? group.initialCount;
  const head = group.sessions.slice(0, cap);
  if (activeId.value && !head.some((s) => s.id === activeId.value)) {
    const active = group.sessions.find((s) => s.id === activeId.value);
    if (active) return [...head, active].map((s) => s.id);
  }
  return head.map((s) => s.id);
}

function pinnedGroupRowCount(group: (typeof groups.value)[number]): number {
  if (isCollapsed(group.workspace.id)) return 1;
  const limit = visibleLimit(group.workspace.id) ?? group.initialCount;
  const canExpand = group.sessions.length > limit || group.hasMore || group.loadingMore;
  const canCollapse = limit > group.initialCount;
  const contentRows = group.sessions.length === 0 ? 1 : visibleGroupRowIds(group).length;
  return 1 + contentRows + (canExpand || canCollapse ? 1 : 0);
}

const pinnedWorkspaceRowCount = computed(() =>
  pinnedWorkspaceGroups.value.reduce((total, group) => total + pinnedGroupRowCount(group), 0),
);

const siblingOrder = computed<string[]>(() => {
  if (props.statusTab === 'open') {
    const pinnedSiblingIds = pinnedEntries.value.flatMap((entry) =>
      entry.kind === 'workspace' ? visibleGroupRowIds(entry.group) : [entry.session.id],
    );
    if (listMode.value === 'flat') {
      return [...pinnedSiblingIds, ...flatSessions.value.map((s) => s.id)];
    }
    return [...pinnedSiblingIds, ...groups.value.flatMap((g) => visibleGroupRowIds(g))];
  }
  if (props.statusTab === 'done') {
    if (listMode.value === 'flat') return doneSessions.value.map((s) => s.id);
    return doneGroups.value.flatMap((g) => g.sessions.map((s) => s.id));
  }
  return allGroups.value.map((g) => g.workspace.id);
});

function groupOfSession(id: string): string | null {
  if (props.statusTab === 'open') {
    return allGroups.value.find((g) => g.sessions.some((s) => s.id === id))?.workspace.id ?? null;
  }
  if (props.statusTab === 'done') {
    return doneGroups.value.find((g) => g.sessions.some((s) => s.id === id))?.workspace.id ?? null;
  }
  return null;
}

function getSiblingOrder(): string[] {
  return siblingOrder.value;
}

function expandGroupIfCollapsed(wsId: string | null, sessionId?: string): void {
  if (props.statusTab === 'open') {
    if (sessionId !== undefined && pinnedSessions.value.some((s) => s.id === sessionId)) {
      revealPinnedSection();
      return;
    }
    if (wsId !== null && pinnedWorkspaceIdsSet.value.has(wsId)) {
      revealPinnedSection();
      if (isCollapsed(wsId)) toggleCollapse(wsId);
      return;
    }
  }
  setSessionsCollapsed(false);
  if (wsId !== null && isCollapsed(wsId)) toggleCollapse(wsId);
}

const openGroups = computed(() =>
  visibleOpenGroups(groups.value, activeWorkspaceId.value, sidebarTabs.value),
);

const displayedOpenGroups = computed(() => [...pinnedWorkspaceGroups.value, ...openGroups.value]);

const openGroupIdsWithActiveSession = computed(() =>
  workspaceIdsContainingSession(displayedOpenGroups.value, activeId.value),
);

function groupActiveId(workspaceId: string): string {
  return scopedActiveSessionId(activeId.value, openGroupIdsWithActiveSession.value.has(workspaceId));
}

const scopePendingByGroup = createGroupScopedRecords<{ approvals: number; questions: number }>(
  (a, b) => a.approvals === b.approvals && a.questions === b.questions,
);
const scopeUnreadByGroup = createGroupScopedRecords<boolean>();
const pendingByOpenGroup = computed(() => scopePendingByGroup(displayedOpenGroups.value, pendingBySession.value));
const unreadByOpenGroup = computed(() => scopeUnreadByGroup(displayedOpenGroups.value, unreadBySession.value));

const doneGroups = computed(() =>
  allGroups.value
    .map((g) => ({
      workspace: g.workspace,
      sessions: doneSessions.value
        .filter((s) => s.workspaceId === g.workspace.id)
        .map((s) => ({ ...s, cwdLabel: undefined })),
    }))
    .filter((g) => g.sessions.length > 0),
);

watch(
  () => initialized.value,
  (ready) => {
    if (!ready) return;
    if (props.statusTab === 'open' && listMode.value === 'flat' && client.ensureSidebarFlatSessions) {
      void client.ensureSidebarFlatSessions();
    } else {
      void client.ensureFlatSessions();
    }
    void client.ensureDoneSessions();
  },
  { immediate: true },
);

watch(
  [
    () => initialized.value,
    () => props.statusTab === 'open' && listMode.value === 'flat',
    () => workspaces.pinnedWorkspaceIds.join('\0'),
  ],
  ([ready, flatActive]) => {
    if (!ready || !flatActive) return;
    if (client.ensureSidebarFlatSessions) {
      void client.ensureSidebarFlatSessions();
    } else {
      void client.ensureFlatSessions();
    }
  },
);

const viewMenuRef = ref<InstanceType<typeof Menu> | null>(null);
const {
  open: viewMenuOpen,
  menuStyle: viewMenuStyle,
  toggleAnchored: toggleViewMenuAnchored,
  close: closeViewMenu,
} = useAnchoredMenu(viewMenuRef);

function toggleViewMenu(e: MouseEvent): void {
  void toggleViewMenuAnchored(e, 'right');
}

function chooseListMode(mode: SidebarViewMode): void {
  setListMode(mode);
  closeViewMenu();
}

function chooseSortMode(mode: WorkspaceSortMode): void {
  client.setWorkspaceSortMode(mode);
  closeViewMenu();
}

function openSessionAdmin(): void {
  client.openSessionAdmin();
  closeViewMenu();
}

const renamingFlatId = ref<string | null>(null);

const flatLikeListActive = computed(
  () => !sessionsCollapsed.value && props.statusTab === 'open' && listMode.value === 'flat',
);

const {
  dropHover: flatPinnedDropHover,
  onDragOver: onSessionsPinnedDragOver,
  onDrop: onSessionsPinnedDrop,
  onDragLeave: onSessionsPinnedDragLeave,
} = usePinnedReturnTarget({
  isTarget: () => flatLikeListActive.value,
  onReturn: (id) => client.unpinSession(id),
});

function handleGhClick(wsId: string, e: MouseEvent): void {
  closeWorkspaceHover();
  if ((e.target as Element).closest('.gh-more, .gh-add')) return;
  toggleCollapse(wsId);
}

function onSelectSession(sessionId: string): void {
  emit('select', sessionId);
}

const pinnedListRef = ref<InstanceType<typeof PinnedSessionList> | null>(null);

function revealPinnedSection(): void {
  if (props.statusTab !== 'open') emit('update:statusTab', 'open');
  if (pinnedListRef.value) {
    pinnedListRef.value.expand();
  } else {
    savePinnedCollapsed(false);
  }
}

function onPinSession(id: string): void {
  revealPinnedSection();
  client.togglePinSession(id);
}

function onPinWorkspace(workspace: WorkspaceView): void {
  if (!workspaces.pinnedWorkspaceIds.includes(workspace.id)) revealPinnedSection();
  client.togglePinWorkspace(workspace.id);
}

function onReloadSession(id: string): void {
  track('session_menu_action', { action: 'reload' });
  void client.reloadSession(id);
}

function onDropPin(id: string, target?: PinnedInsertTarget): void {
  revealPinnedSection();
  client.pinSession(id, target);
}

function onDropPinWorkspace(workspaceId: string, target?: PinnedInsertTarget): void {
  revealPinnedSection();
  client.pinWorkspace(workspaceId, target);
}

function onReorderPinned(fromKey: string, toKey: string, position: DropPosition): void {
  client.reorderPinned(fromKey, toKey, position);
}

const flashSessionId = ref<string | null>(null);
let flashSessionTimer: ReturnType<typeof setTimeout> | null = null;

function readDurationMs(el: HTMLElement, token: string): number {
  const raw = getComputedStyle(el).getPropertyValue(token).trim();
  const match = /^([\d.]+)(ms|s)$/.exec(raw);
  if (!match) return 0;
  const value = Number.parseFloat(match[1]!);
  return match[2] === 's' ? value * 1000 : value;
}

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
  const pinnedGroup = pinnedWorkspaceGroups.value.find((g) => g.sessions.some((s) => s.id === sessionId));
  const pinned = !!pinnedGroup || pinnedSessions.value.some((s) => s.id === sessionId);
  if (pinned) {
    revealPinnedSection();
    if (pinnedGroup && isCollapsed(pinnedGroup.workspace.id)) toggleCollapse(pinnedGroup.workspace.id);
  } else {
    if (props.statusTab !== 'open') emit('update:statusTab', 'open');
    setSessionsCollapsed(false);
    if (listMode.value === 'grouped') {
      const group = groups.value.find((g) => g.sessions.some((s) => s.id === sessionId));
      if (group && isCollapsed(group.workspace.id)) toggleCollapse(group.workspace.id);
    }
  }
  void nextTick(() => {
    const root = pinned ? (pinnedListRef.value?.$el as HTMLElement | null) : sessionsEl.value;
    const row = [...(root?.querySelectorAll<HTMLElement>('[data-session-id]') ?? [])].find(
      (el) => el.dataset.sessionId === sessionId,
    );
    if (!row) return;
    row.scrollIntoView({ block: pinned ? 'nearest' : 'start', behavior: scrollBehavior() });
    flashSessionRow(sessionId, row);
  });
}

const flashWsId = ref<string | null>(null);
let flashWsTimer: ReturnType<typeof setTimeout> | null = null;

function locateWorkspace(workspaceId: string): void {
  const pinned = pinnedWorkspaceGroups.value.some((group) => group.workspace.id === workspaceId);
  if (pinned) revealPinnedSection();
  else {
    if (props.statusTab !== 'open') emit('update:statusTab', 'open');
    if (listMode.value !== 'grouped') setListMode('grouped');
    setSessionsCollapsed(false);
  }
  if (isCollapsed(workspaceId)) toggleCollapse(workspaceId);
  client.openWorkspace(workspaceId);
  void nextTick(() => {
    const root = pinned ? (pinnedListRef.value?.$el as HTMLElement | null) : sessionsEl.value;
    const target = [...(root?.querySelectorAll<HTMLElement>('[data-ws-id]') ?? [])].find(
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

const {
  renamingId,
  renameValue,
  renameInputRef,
  startRenameWorkspace,
  confirmRenameWorkspace,
  cancelRenameWorkspace,
  updateRenameValue,
} = useWorkspaceRename();

onBeforeUnmount(() => cancelRenameWorkspace());

function getRenameInputRef() {
  return renameInputRef;
}

const wsMenuOpenId = ref<string | null>(null);
const workspaceMenuRef = ref<InstanceType<typeof WorkspaceMenu> | null>(null);

function openGhMenu(ws: WorkspaceView, e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  closeWorkspaceHover();
  void workspaceMenuRef.value?.openContext(e, ws);
}

function toggleWsMenu(ws: WorkspaceView, e: MouseEvent): void {
  closeWorkspaceHover();
  void workspaceMenuRef.value?.toggle(e, ws);
}

function copyWsPath(ws: WorkspaceView): void {
  void copyTextToClipboard(ws.root);
}

function startRenameWs(ws: WorkspaceView): void {
  startRenameWorkspace(ws.id, ws.name);
}

function deleteWs(ws: WorkspaceView): void {
  emit('deleteWorkspace', ws.id);
}

const openGroupListeners = {
  onGroupClick: handleGhClick,
  onWorkspaceHoverStart,
  onWorkspaceHoverEnd: scheduleWorkspaceHoverClose,
  onGroupContextmenu: openGhMenu,
  onToggleWsMenu: toggleWsMenu,
  onCreateInWorkspace: (id: string) => emit('createInWorkspace', id),
  onSelectSession,
  onRenameSession: (id: string, title: string) => void client.renameSession(id, title),
  onGenerateSessionTitle: (id: string, done: (title: string | null) => void) => emit('generateTitle', id, done),
  onArchiveSession: (id: string) => void client.archiveSessionWithToast(id),
  onDeleteSession: (id: string) => void client.deleteSessionWithToast(id),
  onForkSession: (id: string) => void client.forkSession(id),
  onReloadSession,
  onExportSession: (id: string) => void client.exportSessionWithToast(id),
  onPinSession,
  onDropPinnedSession,
  onExpand,
  onCollapse,
  onConfirmRename: confirmRenameWorkspace,
  onCancelRename: cancelRenameWorkspace,
  onUpdateRenameValue: updateRenameValue,
};

defineExpose({
  revealPinnedSection,
  locateSession,
  locateWorkspace,
  getSiblingOrder,
  groupOfSession,
  expandGroupIfCollapsed,
  sessionsCanScrollDown,
});
</script>

<template>
  <div class="session-list-panel">
    <div
      class="sessions-head"
      :class="{ 'sessions-head--scrolled': sessionsScrolled }"
    >
      <PinnedSessionList
        v-if="pinnedEntries.length > 0 && statusTab === 'open'"
        ref="pinnedListRef"
        :sessions="pinnedSessions"
        :entries="pinnedEntries"
        :pinned-workspace-ids="pinnedWorkspaceIds"
        :workspace-row-count="pinnedWorkspaceRowCount"
        :active-id="activeId"
        :pending-by-session="pendingBySession"
        :unread-by-session="unreadBySession"
        state-tag="open"
        :flash-session-id="flashSessionId"
        :flash-workspace-id="flashWsId"
        @select-session="onSelectSession"
        @rename-session="(id, title) => void client.renameSession(id, title)"
        @generate-session-title="(id, done) => emit('generateTitle', id, done)"
        @archive-session="(id) => void client.archiveSessionWithToast(id)"
        @delete-session="(id) => void client.deleteSessionWithToast(id)"
        @fork-session="(id) => void client.forkSession(id)"
        @export-session="(id) => void client.exportSessionWithToast(id)"
        @pin-session="onPinSession"
        @reload-session="onReloadSession"
        @drop-pin="onDropPin"
        @drop-pin-workspace="onDropPinWorkspace"
        @reorder-pinned="onReorderPinned"
      >
        <template #workspace="{ group: g }">
          <WorkspaceGroup
            :group="g"
            :active-workspace-id="activeWorkspaceId"
            :active-id="groupActiveId(g.workspace.id)"
            :renaming-id="renamingId"
            :rename-value="renameValue"
            :rename-input-ref="getRenameInputRef()"
            :pending-by-session="pendingByOpenGroup.get(g.workspace.id) ?? EMPTY_GROUP_RECORD"
            :unread-by-session="unreadByOpenGroup.get(g.workspace.id) ?? EMPTY_GROUP_RECORD"
            :ws-menu-open-id="wsMenuOpenId"
            :sortable="true"
            :in-pinned-section="true"
            :is-collapsed="isCollapsed"
            :visible-limit="visibleLimit"
            :flash-session-id="flashSessionId"
            :workspace-hover-enabled="workspaceHoverEnabled"
            state-tag="open"
            v-bind="openGroupListeners"
          />
        </template>
      </PinnedSessionList>
      <SidebarSectionHeader
        :title="sectionHeaderTitle"
        :collapsed="sessionsCollapsed"
        :toggle-label="sectionFoldLabel"
        label-class="side-section-label"
        heading-class="side-section-heading"
        title-class="side-section-title"
        toggle-class="side-section-fold"
        collapsed-toggle-class="side-section-fold--on"
        actions-class="side-section-actions"
        @toggle="toggleSessionsCollapsed"
      >
        <template #actions>
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
          <Tooltip v-if="statusTab !== 'workspaces' && listMode === 'grouped'" :text="t('sidebar.newWorkspace')">
            <IconButton
              class="side-section-toggle"
              size="sm"
              :label="t('sidebar.newWorkspace')"
              @click.stop="emit('addWorkspace')"
            >
              <Icon name="folder-plus" />
            </IconButton>
          </Tooltip>
          <Tooltip v-if="statusTab !== 'workspaces'" :text="t('sidebar.viewSwitcher')">
            <IconButton
              class="side-section-toggle side-section-view"
              size="sm"
              :label="t('sidebar.viewSwitcher')"
              @click.stop="toggleViewMenu"
            >
              <Icon name="view-switch" />
            </IconButton>
          </Tooltip>
        </template>
      </SidebarSectionHeader>
    </div>

    <div
      ref="sessionsEl"
      class="sessions"
      :class="{
        scrolling: sessionsScrolling,
        'sessions--collapsed': sessionsCollapsed,
        'pinned-drag-active': flatLikeListActive && pinnedDragSession !== null,
        'flat-pinned-drop-hover': flatPinnedDropHover,
      }"
      :inert="sessionsCollapsed || undefined"
      @scroll="onSessionsScroll"
      @dragover="onSessionsPinnedDragOver"
      @drop="onSessionsPinnedDrop"
      @dragleave="onSessionsPinnedDragLeave"
      @mouseenter="onSessionsListMouseEnter"
      @mouseleave="onSessionsListMouseLeave"
    >
      <template v-if="statusTab === 'open'">
        <template v-if="listMode === 'flat'">
          <SessionRow
            v-for="s in flatSessions"
            :key="s.id"
            :data-session-id="s.id"
            :class="{ 'se-locate-flash': flashSessionId === s.id }"
            :session="s"
            :active="s.id === activeId"
            :approval-count="pendingBySession[s.id]?.approvals ?? 0"
            :question-count="pendingBySession[s.id]?.questions ?? 0"
            :unread="unreadBySession[s.id] ?? false"
            state-tag="open"
            :draggable="renamingFlatId !== s.id"
            @dragstart="startSessionRowDrag"
            @rename-state-change="renamingFlatId = $event ? s.id : null"
            @select="onSelectSession"
            @rename="(id, title) => void client.renameSession(id, title)"
            @generate-title="(id, done) => emit('generateTitle', id, done)"
            @archive="(id) => void client.archiveSessionWithToast(id)"
            @delete="(id) => void client.deleteSessionWithToast(id)"
            @fork="(id) => void client.forkSession(id)"
            @reload="onReloadSession"
            @export="(id) => void client.exportSessionWithToast(id)"
            @pin="onPinSession"
          />
          <div
            v-if="flatSessions.length === 0 && !flatHasMore && pinnedSessions.length === 0 && pinnedWorkspaceGroups.length === 0"
            class="empty"
          >
            {{ t('sidebar.noSessions') }}
          </div>
          <div v-if="flatHasMore" class="show-more-row">
            <button
              class="show-more"
              :disabled="flatLoadingMore"
              @click.stop="loadMoreSidebarFlat()"
            >
              <span class="show-more-label">{{
                flatLoadingMore ? t('sidebar.loadingMore') : t('sidebar.loadMore')
              }}</span>
              <Icon name="chevron-down" size="sm" />
            </button>
          </div>
        </template>
        <template v-else>
          <div v-if="groups.length === 0 && pinnedWorkspaceGroups.length === 0" class="empty">
            {{ t('workspace.noWorkspace') }}
          </div>
          <div v-else-if="openGroups.length === 0 && pinnedSessions.length === 0 && pinnedWorkspaceGroups.length === 0" class="empty">
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
                :active-id="groupActiveId(g.workspace.id)"
                :renaming-id="renamingId"
                :rename-value="renameValue"
                :rename-input-ref="getRenameInputRef()"
                :pending-by-session="pendingByOpenGroup.get(g.workspace.id) ?? EMPTY_GROUP_RECORD"
                :unread-by-session="unreadByOpenGroup.get(g.workspace.id) ?? EMPTY_GROUP_RECORD"
                :ws-menu-open-id="wsMenuOpenId"
                :sortable="true"
                :is-collapsed="isCollapsed"
                :visible-limit="visibleLimit"
                :flash-session-id="flashSessionId"
                :workspace-hover-enabled="workspaceHoverEnabled"
                state-tag="open"
                v-bind="openGroupListeners"
              />
            </div>
          </template>
        </template>
      </template>

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
            @rename="(id, title) => void client.renameSession(id, title)"
            @generate-title="(id, done) => emit('generateTitle', id, done)"
            @restore="(id) => void client.restoreSessionWithToast(id)"
            @delete="(id) => void client.deleteSessionWithToast(id)"
            @fork="(id) => void client.forkSession(id)"
            @export="(id) => void client.exportSessionWithToast(id)"
          />
        </template>
        <template v-else>
          <div v-for="g in doneGroups" :key="g.workspace.id" class="done-group">
            <div
              class="done-gh"
              :class="{ 'host-unavailable': hostsStore().unavailable(g.workspace.hostId) }"
              @click="toggleCollapse(g.workspace.id)"
              @mouseenter="onWorkspaceHoverMouseEnter(g.workspace, $event)"
              @mouseleave="scheduleWorkspaceHoverClose"
              @contextmenu="openGhMenu(g.workspace, $event)"
            >
              <WorkspaceIcon v-if="g.workspace.hostId !== undefined" class="done-gh-folder" :host-id="g.workspace.hostId" status="all" />
              <Icon v-else-if="isCollapsed(g.workspace.id)" class="done-gh-folder" name="folder-closed" />
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
                @rename="(id, title) => void client.renameSession(id, title)"
                @generate-title="(id, done) => emit('generateTitle', id, done)"
                @restore="(id) => void client.restoreSessionWithToast(id)"
                @delete="(id) => void client.deleteSessionWithToast(id)"
                @fork="(id) => void client.forkSession(id)"
                @export="(id) => void client.exportSessionWithToast(id)"
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
            @click.stop="void client.loadMoreDoneSessions()"
          >
            <span class="show-more-label">{{
              doneLoadingMore ? t('sidebar.loadingMore') : t('sidebar.loadMore')
            }}</span>
            <Icon name="chevron-down" size="sm" />
          </button>
        </div>
      </template>

      <template v-else>
        <WorkspaceDirectory
          :ws-menu-open-id="wsMenuOpenId"
          :workspace-hover-enabled="workspaceHoverEnabled"
          @create-in-workspace="(id) => emit('createInWorkspace', id)"
          @open-menu="openGhMenu"
          @toggle-menu="toggleWsMenu"
          @workspace-hover-start="onWorkspaceHoverStart"
          @workspace-hover-end="scheduleWorkspaceHoverClose"
        />
      </template>
    </div>

    <div
      v-if="!sessionsCollapsed && sessionsThumb"
      class="sessions-thumb"
      :class="{ visible: sessionsThumbVisible }"
      :style="{ top: `${sessionsThumb.top}px`, height: `${sessionsThumb.height}px` }"
      aria-hidden="true"
      @pointerdown="onSessionsThumbPointerDown"
      @mouseenter="onSessionsThumbMouseEnter"
      @mouseleave="onSessionsThumbMouseLeave"
    />

    <WorkspaceMenu
      ref="workspaceMenuRef"
      :open-id="wsMenuOpenId"
      :can-edit="props.canEditWorkspace"
      @update:open-id="wsMenuOpenId = $event"
      @pin="onPinWorkspace"
      @copy-path="copyWsPath"
      @rename="startRenameWs"
      @edit="(ws) => emit('editWorkspace', ws)"
      @remove="deleteWs"
    />
    <WorkspaceHoverCard
      v-if="hoverWorkspace"
      :workspace="hoverWorkspace"
      :style="hoverCardStyle"
      :can-open="props.canOpenWorkspaceDirectory"
      @open-directory="(path) => emit('openWorkspaceDirectory', path)"
      @mouseenter="cancelWorkspaceHoverClose"
      @mouseleave="scheduleWorkspaceHoverClose"
    />
    <Transition name="ui-menu-pop">
      <Menu
        v-if="viewMenuOpen"
        ref="viewMenuRef"
        class="view-menu ui-menu-floating"
        :style="viewMenuStyle"
        @click.stop
      >
        <div class="view-menu-label anchored-menu-label">{{ t('sidebar.viewGroup') }}</div>
        <MenuItem @click="chooseListMode('flat')">
          <Icon name="list" size="sm" />
          {{ t('sidebar.viewFlat') }}
          <span class="view-menu-check anchored-menu-check">
            <Icon v-if="listMode === 'flat'" name="check" size="sm" />
          </span>
        </MenuItem>
        <MenuItem @click="chooseListMode('grouped')">
          <Icon name="folder-tree" size="sm" />
          {{ t('sidebar.viewGrouped') }}
          <span class="view-menu-check anchored-menu-check">
            <Icon v-if="listMode === 'grouped'" name="check" size="sm" />
          </span>
        </MenuItem>
        <template v-if="listMode === 'grouped'">
          <div class="view-menu-label anchored-menu-label">{{ t('sidebar.sortGroup') }}</div>
          <MenuItem @click="chooseSortMode('manual')">
            <Icon name="grip" size="sm" />
            {{ t('sidebar.sortManual') }}
            <span class="view-menu-check anchored-menu-check">
              <Icon v-if="workspaceSortMode === 'manual'" name="check" size="sm" />
            </span>
          </MenuItem>
          <MenuItem @click="chooseSortMode('recent')">
            <Icon name="clock" size="sm" />
            {{ t('sidebar.sortRecent') }}
            <span class="view-menu-check anchored-menu-check">
              <Icon v-if="workspaceSortMode === 'recent'" name="check" size="sm" />
            </span>
          </MenuItem>
        </template>
        <template v-if="sidebarTabs">
          <MenuItem separator />
          <MenuItem @click="openSessionAdmin">
            <Icon name="session-admin" size="sm" />
            {{ t('sidebar.sessionAdmin') }}
          </MenuItem>
        </template>
      </Menu>
    </Transition>
  </div>
</template>

<style scoped>
.session-list-panel {
  display: contents;
}

.sessions-head {
  position: relative;
  z-index: 1;
  padding: var(--space-3) var(--sb-inset) 0;
  border-bottom: var(--p-hairline) solid transparent;
  transition: border-color var(--duration-base) var(--ease-out),
    box-shadow var(--duration-base) var(--ease-out);
}
.sessions-head::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: var(--p-sidebar-seam-h);
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
  top: 100%;
  background:
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1.5%, transparent), transparent 35%),
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1%, transparent), transparent 65%),
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 0.75%, transparent), transparent);
  transition-duration: var(--duration-slow);
}
.sessions-head--scrolled {
  border-bottom-color: var(--color-line);
}
.sessions-head--scrolled::after { opacity: 1; }

.sessions-head .pinned + .side-section-label {
  margin-top: var(--space-1);
}
.side-section-toggle {
  color: var(--color-text-quaternary);
}
.side-section-toggle:hover {
  color: var(--color-text-muted);
}
.side-section-toggle svg {
  width: 13px;
  height: 13px;
}

.sessions {
  flex: 1;
  overflow-y: auto;
  padding: 0 var(--sb-inset) var(--space-3);
  min-height: 0;
  --overlay-scrollbar-thumb-min: var(--space-6);
  scrollbar-width: none;
  opacity: 1;
  visibility: visible;
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out),
    visibility 0s;
}
.sessions.sessions--collapsed {
  overflow-y: hidden;
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-6px);
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out),
    visibility 0s linear var(--duration-base);
}
@media (prefers-reduced-motion: reduce) {
  .sessions,
  .sessions.sessions--collapsed {
    transition: none;
  }
}
.sessions::-webkit-scrollbar { display: none; }
.sessions.pinned-drag-active { box-shadow: inset 0 0 0 1px var(--color-accent); }
.sessions.flat-pinned-drop-hover { box-shadow: inset 0 0 0 2px var(--color-accent); }

.sessions-thumb {
  position: absolute;
  right: 0;
  width: var(--space-1);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-text) 12%, transparent);
  opacity: 0;
  pointer-events: none;
  transition:
    opacity var(--duration-base) var(--ease-out),
    background var(--duration-base) var(--ease-out);
  z-index: var(--z-raised);
  touch-action: none;
}
.sessions-thumb.visible {
  opacity: 1;
  pointer-events: auto;
}
.sessions-thumb.visible:hover {
  background: color-mix(in srgb, var(--color-text) 25%, transparent);
}
.sessions-thumb::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(-1 * var(--space-2));
  right: 0;
}

.ws-drop-target.drop-before { box-shadow: inset 0 2px 0 var(--color-accent); }
.ws-drop-target.drop-after { box-shadow: inset 0 -2px 0 var(--color-accent); }

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
.done-gh.host-unavailable .done-gh-name { color: var(--color-text-faint); }
.done-gh-name {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
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

</style>

<style scoped src="../lib/locate-flash.css"></style>

<style scoped src="./sidebar-empty.css"></style>
