<script setup lang="ts">
import { parseComposerSnapshot, type ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';
import { computed, inject, nextTick, onMounted, onUnmounted, provide, ref, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatTurn, ConversationStatus, OpenMediaRequest, QueuedPromptView, TaskItem, TurnAttachment, UIQuestion } from '../../types';
import type { QuestionResponse } from '../../api/types';
import type { PromptAttachment } from '@moonshot-ai/app-client/client';
import { HistoryScrollKey } from '@moonshot-ai/app-core/contracts';
import { useSidebarTabs } from '@moonshot-ai/app-core';
import { ChatPane } from '@moonshot-ai/app-components';
import { HostNotice, WorkspaceIcon } from '@moonshot-ai/app-components/support';
import { hostsStore } from '@moonshot-ai/app-client/stores';
import { isWideTableLayoutActive, useWideTableToc } from '@moonshot-ai/app-components';
import { ErrorBoundary } from '@moonshot-ai/app-components';
import ChatHeader from './ChatHeader.vue';
import ViewToggles from './ViewToggles.vue';
import { Composer } from '@moonshot-ai/app-components';
import { WorkspaceTrustDialog } from '@moonshot-ai/app-components';
import ChatDock from './ChatDock.vue';
import SessionInfoPanel from './SessionInfoPanel.vue';
import { useSessionInfoLayout } from '../../composables/useSessionInfoLayout';
import WorkspaceHome from './WorkspaceHome.vue';
import { WorkspaceRecentSessions } from '@moonshot-ai/app-components';
import { ConversationToc, type ConversationTocItem } from '@moonshot-ai/app-components';
import TranscriptSearch from './TranscriptSearch.vue';
import { KimiCodeWordmark, KimiMascotPeek } from '@moonshot-ai/app-components';
import { Icon, Spinner, Tooltip, trackMenuSurface, useImeComposition } from '@moonshot-ai/app-ui';
import { filterWorkspaces } from '@moonshot-ai/app-core/lib';
import { safeRemove, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { isMacosDesktop } from '@moonshot-ai/app-core/lib';
import { osGlobalFailures, resolvedBindingKeys } from '../../composables/useShortcuts';
import { OpenShortcutSettingsKey } from '../../lib/shortcutSettings';
import { closestRegion, isEditableTarget, isSelectAllKeyEvent, selectContentsOf } from '@moonshot-ai/app-core/lib';
import { isFindKeyEvent } from '@moonshot-ai/app-core/lib';
import { nestedScrollerTakesUpwardScroll, nextJumpPillVisible, scrollKeyDirection } from '@moonshot-ai/app-core/lib';
import { reviveQuoteBlockLinks } from '@moonshot-ai/app-composer/model';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import { FetchTurnFileChangesKey, ModelDisplayKey, PinScrollKey, ResolveAgentModelKey, ResolveAgentTaskIdKey, ResolveAgentTaskStateKey, ResolveDetachableTaskKey, SubagentEffortKey } from '@moonshot-ai/app-client/contracts';
import { sessionObservationOptions, toast, turnFileChangesFetcher } from '@moonshot-ai/app-client/client';
import { track } from '../../lib/track';
import { useComposerAutoFocus, useEscInterrupt, useWorkspaceTrust } from '@moonshot-ai/app-client/composables';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { workspacesStore, sessionRuntimeStore } from '@moonshot-ai/app-client/stores';
import { useAppDialogs } from '@moonshot-ai/app-client/composables';
import type { SelectionActionPayload } from '@moonshot-ai/app-client/lib';
import type { PanelTab } from '@moonshot-ai/app-client/composables';
import type { PanelLauncherType } from '@moonshot-ai/app-client/panel';
import type { PanelLauncherItem } from '../../lib/panelLauncher';
import { historyRenderAllAffordable, turnHasOutput, turnTocTitle } from '@moonshot-ai/app-components';
import type { TurnFileChange } from '@moonshot-ai/app-components';

const { t } = useI18n();

const props = defineProps<{
  sessionId?: string;
  status: ConversationStatus;
  planMode?: boolean;
  pendingQuestionActions?: Record<string, 'answer' | 'dismiss'>;
  pendingApprovalActions?: Record<string, true>;
  queued?: QueuedPromptView[];
  working?: boolean;
  mobile?: boolean;
  loadingMoreError?: boolean;
  rightPanelOpen?: boolean;
  mainView?: 'chat' | 'sessionAdmin';
  panelTabs?: PanelTab[];
  availableTabs?: PanelLauncherItem[];
}>();

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: PromptAttachment[]; restoreText?: string; editText?: string; restoreEntries?: AttachmentEntry[]; snapshot?: ComposerDocumentSnapshot; skills?: { name: string; path?: string }[]; forceQueue?: boolean }];
  steer: [payload: { text: string; attachments: PromptAttachment[]; restoreText?: string; restoreEntries?: AttachmentEntry[]; snapshot?: ComposerDocumentSnapshot; skills?: { name: string; path?: string }[] }];
  command: [payload: { cmd: string; attachments: PromptAttachment[]; restoreText?: string; skillName?: string; skillPath?: string; restoreEntries?: AttachmentEntry[]; snapshot?: ComposerDocumentSnapshot; editText?: string; delivery?: 'steer' | 'queue' }];
  interrupt: [];
  steerQueued: [index: number];
  pickModel: [];
  login: [];
  configureModel: [];
  openMedia: [payload: OpenMediaRequest];
  editMessage: [payload: { text: string; attachments?: TurnAttachment[]; snapshot?: ComposerDocumentSnapshot; turnId: string }];
  quoteAction: [payload: SelectionActionPayload];
  screenshot: [];
  selectWorkspace: [workspaceId: string];
  addWorkspace: [];
  openPr: [url: string];
  openDiff: [root: string];
  activateTab: [id: string];
  openTab: [type: PanelLauncherType];
  showTabs: [];
  togglePin: [id: string];
}>();

const screenshotSupported = (
  window as { kimiDesktop?: { isScreenshotSupported?: () => boolean } }
).kimiDesktop?.isScreenshotSupported?.() === true;
const captureScreenshotAction = screenshotSupported ? () => emit('screenshot') : undefined;
const openShortcutSettings = inject(OpenShortcutSettingsKey, undefined);
const configureScreenshotShortcut = screenshotSupported && openShortcutSettings
  ? () => openShortcutSettings('captureScreenshot')
  : undefined;
const screenshotShortcutKeys = computed(() =>
  screenshotSupported ? resolvedBindingKeys('captureScreenshot') : [],
);

const client = useKimiWebClient();
const { anyOverlayOpen } = useAppDialogs();

const turns = client.turns;
const approvals = client.pendingApprovals;
const tasks = client.tasks;
const todos = client.todos;
const goal = client.goal;
const sessionPlans = client.sessionPlans;
const questions = client.questions;
const turnActive = client.turnActive;
const starting = client.isStartingFirstPrompt;
const sessionLoading = client.sessionLoading;
const compaction = client.compaction;
const hasMoreMessages = client.hasMoreMessages;
const loadingMore = client.loadingMoreMessages;
const workspaces = client.workspacesView;
const activeWorkspaceId = client.activeWorkspaceId;
const draftEntry = client.draftEntry;
const workspaceName = computed(() => client.visibleWorkspace.value?.name);
const activeHostId = computed(() => client.visibleWorkspace.value?.hostId);
const hostBlocked = computed(() => hostsStore().blocked(activeHostId.value));
const workspaceRoot = computed(() => client.visibleWorkspace.value?.root ?? client.status.value.cwd);
const workspaceDirs = computed(() => {
  const root = workspaceRoot.value;
  if (!root) return [];
  const registered = workspacesStore().workspaces.find((ws) => ws.id === activeWorkspaceId.value);
  return [root, ...(registered?.additionalDirs ?? [])];
});
const turnError = computed(() => client.activeTurnError.value ?? null);
const turnRetry = computed(() => client.activeTurnRetry.value ?? null);
const turnEnd = client.activeTurnEnd;
const recentSessions = computed(() => client.recentSessionsForWorkspace(client.activeWorkspaceId.value));

const {
  trustDenied,
  trustRejected,
  trustGateOpen,
  busy: trustBusy,
  trustWorkspace: onTrustWorkspace,
  rejectTrust,
  gateSubmitForTrust,
} = useWorkspaceTrust();

function gateSubmit(): boolean {
  return !hostBlocked.value && gateSubmitForTrust();
}


const isEmptyDraft = computed(() => turns.value.length === 0 && !sessionLoading.value);
const showTrustDialog = computed(
  () => trustDenied.value && (trustGateOpen.value || (isEmptyDraft.value && !trustRejected.value)),
);

const conversationRootRef = ref<HTMLElement | null>(null);
const sessionInfoSessionId = computed(() => props.sessionId ?? '');
const sessionInfoEligible = computed(() =>
  !props.mobile && props.mainView !== 'sessionAdmin' && !isEmptyDraft.value,
);
const {
  hostWidth: conversationHostWidth,
  mode: sessionInfoMode,
  visible: sessionInfoVisible,
  toggle: toggleSessionInfo,
} = useSessionInfoLayout({
  host: conversationRootRef,
  activeSessionId: computed(() => props.sessionId),
  rightPanelOpen: computed(() => props.rightPanelOpen === true),
  eligible: sessionInfoEligible,
});

function onRejectTrust(): void {
  trustGateOpen.value = false;
  if (isEmptyDraft.value) rejectTrust();
}

const wsPickOpen = ref(false);
const wsPanelRef = ref<HTMLElement | null>(null);
trackMenuSurface(wsPickOpen, wsPanelRef);
const wsPickUp = ref(false);
const wsPickMaxHeight = ref<string | null>(null);

const activeWorkspaceLabel = computed(() => {
  const w = workspaces.value.find((ws) => ws.id === activeWorkspaceId.value);
  return w?.name ?? workspaceName.value ?? '';
});

const { sidebarTabs } = useSidebarTabs();
const showWorkspaceHome = computed(
  () => !props.mobile && !starting.value && draftEntry.value === 'workspace' && sidebarTabs.value,
);

const hasWorkspaces = computed(() => workspaces.value.length > 0);

const workspaceQuery = ref('');
const wsSearchInputRef = ref<HTMLInputElement | null>(null);
const filteredWorkspaces = computed(() =>
  filterWorkspaces(workspaces.value, workspaceQuery.value, hostsStore().searchTerms),
);

watch(wsPickOpen, async (open) => {
  if (!open) {
    workspaceQuery.value = '';
    return;
  }
  await nextTick();
  wsSearchInputRef.value?.focus();
});

function toggleWsPick(event: MouseEvent): void {
  if (wsPickOpen.value) {
    wsPickOpen.value = false;
    return;
  }
  const anchor = (event.currentTarget as HTMLElement | null)?.closest('.ws-anchor');
  const scroller = anchor?.closest('.panes');
  if (anchor instanceof HTMLElement && scroller instanceof HTMLElement) {
    const chip = anchor.getBoundingClientRect();
    const port = scroller.getBoundingClientRect();
    const below = port.bottom - chip.bottom - 4;
    const above = chip.top - port.top - 4;
    wsPickUp.value = above > below;
    const available = Math.max(0, Math.floor(wsPickUp.value ? above : below));
    wsPickMaxHeight.value = `min(calc(var(--space-8) * 10), ${available}px)`;
  } else {
    wsPickUp.value = false;
    wsPickMaxHeight.value = null;
  }
  wsPickOpen.value = true;
}

function pickWorkspace(id: string): void {
  if (hostsStore().blocked(workspaces.value.find((workspace) => workspace.id === id)?.hostId)) return;
  wsPickOpen.value = false;
  if (id !== activeWorkspaceId.value) emit('selectWorkspace', id);
}

safeRemove(STORAGE_KEYS.contentAlign);

const chatPaneRef = ref<InstanceType<typeof ChatPane> | null>(null);
const emptyComposerRef = ref<ComposerHandle | null>(null);
const mascotRef = ref<InstanceType<typeof KimiMascotPeek> | null>(null);
watch(client.draftEntryNonce, () => {
  void nextTick(() => mascotRef.value?.playEntrance());
});
const dockedComposerRef = ref<ComposerHandle | null>(null);
function loadComposerForEdit(
  value: string,
  attachments?: TurnAttachment[],
  restoreEntries?: AttachmentEntry[],
  snapshot?: ComposerDocumentSnapshot,
): boolean {
  const composer = dockedComposerRef.value ?? emptyComposerRef.value;
  if (!composer) return false;
  const ok = composer.loadForEdit(value, snapshot);
  if (ok === false) return false;
  if (snapshot !== undefined) return true;
  if (restoreEntries !== undefined && composer.restoreDraftEntries) {
    composer.restoreDraftEntries(restoreEntries);
    return true;
  }
  composer.loadAttachmentsForEdit(attachments ?? []);
  return true;
}

function insertComposerQuote(quote: string, comment?: string, source?: string): boolean {
  const composer = dockedComposerRef.value ?? emptyComposerRef.value;
  if (!composer?.insertQuote) return false;
  const ok = composer.insertQuote(quote, comment, source);
  return ok !== false;
}

function insertComposerPathMention(path: string, kind: 'file' | 'folder'): boolean {
  const composer = dockedComposerRef.value ?? emptyComposerRef.value;
  if (!composer?.insertPathMention) return false;
  const ok = composer.insertPathMention(path, kind);
  return ok !== false;
}

function insertScreenshotAnnotation(file: File, comment: string): boolean {
  const composer = dockedComposerRef.value ?? emptyComposerRef.value;
  if (!composer?.insertScreenshotAnnotation) return false;
  const ok = composer.insertScreenshotAnnotation(file, comment);
  return ok !== false;
}

function addComposerFiles(files: File[]): boolean {
  const composer = dockedComposerRef.value ?? emptyComposerRef.value;
  if (!composer?.addFiles) return false;
  const ok = composer.addFiles(files);
  return ok !== false;
}

function hasInsertableComposer(): boolean {
  const docked = dockedComposerRef.value;
  if (docked?.hasInsertableComposer !== undefined) return docked.hasInsertableComposer();
  return emptyComposerRef.value?.insertQuote !== undefined;
}

function isComposerEmpty(): boolean {
  const composer = dockedComposerRef.value ?? emptyComposerRef.value;
  return composer ? (composer.isEmpty?.() ?? true) : true;
}

const backgroundTasks = computed(() => tasks.value.filter((t) => t.runInBackground === true));
const bashTasks = computed(() =>
  backgroundTasks.value.filter(
    (t) => t.kind === 'bash' || (t.kind === 'tool' && !t.id.startsWith('question-')),
  ),
);
const subagentTasks = computed(() => backgroundTasks.value.filter((t) => t.kind === 'subagent'));
const bashRunning = computed(() => bashTasks.value.filter((t) => t.state === 'run').length);
const subagentRunning = computed(() => subagentTasks.value.filter((t) => t.state === 'run').length);

function resolveAgentTaskId(toolCallId: string): string | undefined {
  const allTasks = tasks.value;
  const task =
    allTasks.find((tk) => tk.id === toolCallId) ?? allTasks.find((tk) => tk.parentToolCallId === toolCallId);
  if (task?.agentId) return task.agentId;
  const unmapped = allTasks.filter(
    (tk) => tk.kind === 'subagent' && !tk.parentToolCallId && tk.agentId,
  );
  if (unmapped.length === 1) return unmapped[0]!.agentId;
  return undefined;
}
provide(ResolveAgentTaskIdKey, resolveAgentTaskId);
const modelDisplay = inject(ModelDisplayKey);
const subagentEffort = inject(SubagentEffortKey);
function resolveAgentModel(
  toolCallId: string,
  agentId?: string,
): { display?: string; effort?: string } | undefined {
  const target = agentId ?? resolveAgentTaskId(toolCallId);
  if (target === undefined) return undefined;
  const task = tasks.value.find((tk) => tk.agentId === target || tk.id === target);
  const display = modelDisplay?.(task?.model);
  const effort = subagentEffort?.(task?.thinkingEffort);
  if (display === undefined && effort === undefined) return undefined;
  return { display, effort };
}
provide(ResolveAgentModelKey, resolveAgentModel);
function resolveAgentTaskState(
  toolCallId: string,
  agentId: string | undefined,
): TaskItem['state'] | undefined {
  const byCall = tasks.value.find((tk) => tk.parentToolCallId === toolCallId);
  if (byCall !== undefined) return byCall.state;
  if (agentId === undefined) return undefined;
  return tasks.value.find(
    (tk) => (tk.agentId === agentId || tk.id === agentId) && tk.parentToolCallId === undefined,
  )?.state;
}
provide(ResolveAgentTaskStateKey, resolveAgentTaskState);
function resolveDetachableTask(toolCallId: string): boolean {
  return tasks.value.some(
    (tk) => tk.parentToolCallId === toolCallId && tk.state === 'run' && tk.runInBackground !== true,
  );
}
provide(ResolveDetachableTaskKey, resolveDetachableTask);
provide(PinScrollKey, pinScrollFor);
const pendingHistoryScrolls = new Map<HTMLElement, { top: number }>();
provide(HistoryScrollKey, (container, delta) => {
  if (!delta || (container === panesRef.value && following.value)) return;
  const existing = pendingHistoryScrolls.get(container);
  if (existing) { existing.top += delta; return; }
  const pending = { top: container.scrollTop + delta };
  pendingHistoryScrolls.set(container, pending);
  void nextTick(() => {
    if (pendingHistoryScrolls.get(container) !== pending) return;
    pendingHistoryScrolls.delete(container);
    if (!container.isConnected || (container === panesRef.value && following.value)) return;
    container.scrollTop = pending.top;
    if (container === panesRef.value) lastScrollTop = container.scrollTop;
  });
});
provide(FetchTurnFileChangesKey, turnFileChangesFetcher(
  () => props.sessionId,
  () => sessionObservationOptions(props.sessionId),
));
const todoDoneCount = computed(() => todos.value.filter((td) => td.status === 'done').length);
const hasDockWork = computed(() =>
  goal.value != null ||
  bashTasks.value.length > 0 ||
  subagentTasks.value.length > 0 ||
  todos.value.length > 0,
);
const dockPanel = ref<'bash' | 'subagent' | 'todos' | 'goal' | 'plan' | null>(null);

function toggleDockPanel(panel: 'bash' | 'subagent' | 'todos' | 'goal' | 'plan'): void {
  if (pendingQuestion.value) return;
  dockPanel.value = dockPanel.value === panel ? null : panel;
}

function closeDockPanel(): void {
  dockPanel.value = null;
}

function focusGoal(): void {
  if (goal.value && !pendingQuestion.value) dockPanel.value = 'goal';
}

watch(
  () => [goal.value, bashTasks.value.length, subagentTasks.value.length, todos.value.length, props.planMode, sessionPlans.value] as const,
  () => {
    const panel = dockPanel.value;
    if (panel === null) return;
    const backed =
      (panel === 'goal' && goal.value != null) ||
      (panel === 'bash' && bashTasks.value.length > 0) ||
      (panel === 'subagent' && subagentTasks.value.length > 0) ||
      (panel === 'todos' && todos.value.length > 0) ||
      (panel === 'plan' &&
        (props.planMode === true || Object.keys(sessionPlans.value).length > 0));
    if (!backed) closeDockPanel();
  },
);

function tocTitle(turn: ChatTurn): string {
  return turnTocTitle(turn, t);
}

const conversationTocItems = computed<ConversationTocItem[]>(() =>
  turns.value
    .filter((turn) => turn.role === 'user')
    .map((turn, index) => ({
      id: turn.id,
      role: turn.role,
      no: index + 1,
      title: tocTitle(turn),
    })),
);

const activeTurnId = ref<string | null>(null);
const turnQuestionIds = computed(() => {
  const result = new Map<string, string>();
  let questionId: string | null = null;
  for (const turn of turns.value) {
    if (turn.role === 'user') questionId = turn.id;
    if (questionId !== null) result.set(turn.id, questionId);
  }
  return result;
});

function updateActiveTocQuery(): void {
  const pane = panesRef.value;
  if (!pane) return;
  const items = conversationTocItems.value;
  if (items.length === 0) return;

  if (distanceFromBottom() <= BOTTOM_THRESHOLD) {
    activeTurnId.value = items[items.length - 1]!.id;
    return;
  }

  if (tocAnchorsDirty || tocAnchorsCache === null) {
    const scrollTop = pane.scrollTop;
    const paneTop = pane.getBoundingClientRect().top;
    const measured: { id: string; top: number }[] = [];
    for (const el of pane.querySelectorAll<HTMLElement>('.turn-anchor[data-turn-id]')) {
      const id = el.dataset.turnId;
      if (id) measured.push({ id, top: el.getBoundingClientRect().top - paneTop + scrollTop });
    }
    tocAnchorsCache = measured;
    tocAnchorsDirty = false;
  }
  const paneMiddle = pane.scrollTop + pane.clientHeight / 2;
  let bestId: string | null = null;
  for (const anchor of tocAnchorsCache) {
    const questionId = turnQuestionIds.value.get(anchor.id);
    if (questionId && anchor.top <= paneMiddle) bestId = questionId;
  }
  activeTurnId.value = bestId ?? items[0]!.id;
}

let tocAnchorsCache: { id: string; top: number }[] | null = null;
let tocAnchorsDirty = true;

function markTocAnchorsDirty(): void {
  tocAnchorsDirty = true;
}

let activeTocRaf = 0;

function scheduleActiveTocUpdate(): void {
  if (activeTocRaf) return;
  activeTocRaf = raf(() => {
    activeTocRaf = 0;
    updateActiveTocQuery();
  });
}

const { tocHidden: tocHiddenByWideTable, syncWideTable } = useWideTableToc();
const wideTableActive = computed(() => isWideTableLayoutActive(tocHiddenByWideTable.value, conversationHostWidth.value));
const sessionInfoPanelVisible = computed(() => sessionInfoVisible.value && !wideTableActive.value);

function syncWideTableToc(): void {
  syncWideTable(panesRef.value);
}

function onTableLayout(): void {
  syncWideTableToc();
  markTocAnchorsDirty();
}

const pendingQuestion = computed<UIQuestion | undefined>(() =>
  questions.value.length > 0 ? questions.value[0] : undefined,
);

const questionBusyKind = computed<'answer' | 'dismiss' | undefined>(() => {
  const q = pendingQuestion.value;
  if (!q) return undefined;
  return props.pendingQuestionActions?.[q.questionId];
});

const pendingApproval = computed(() =>
  approvals.value.length > 0 ? approvals.value[0] : undefined,
);

const approvalBusy = computed<boolean>(() => {
  const a = pendingApproval.value;
  if (!a) return false;
  return !!props.pendingApprovalActions?.[a.approvalId];
});

const panesRef = ref<HTMLElement | null>(null);
const dockRef = ref<HTMLElement | null>(null);
const panesScrollbarWidth = ref(0);
const dockHeight = ref(0);

const transcriptSearchOpen = ref(false);
const historySelection = ref(false);
const activeSessionPaged = ref(false);
const historyState = new Map<string, unknown>();

watch(
  () => props.sessionId,
  () => {
    activeSessionPaged.value = hasMoreMessages.value;
  },
  { immediate: true },
);

watch(hasMoreMessages, (hasMore) => {
  if (hasMore) activeSessionPaged.value = true;
});
const transcriptSearchRef = ref<InstanceType<typeof TranscriptSearch> | null>(null);
let searchPreFocus: Element | null = null;

function openTranscriptSearch(): void {
  if (turns.value.length === 0) return;
  if (transcriptSearchOpen.value) {
    transcriptSearchRef.value?.focusInput();
    return;
  }
  searchPreFocus = document.activeElement;
  transcriptSearchOpen.value = true;
  track('search_opened', {});
}

function closeTranscriptSearch(): void {
  if (searchPreFocus instanceof HTMLElement && searchPreFocus.isConnected) {
    searchPreFocus.focus();
  }
  searchPreFocus = null;
  transcriptSearchOpen.value = false;
}

watch(
  () => turns.value.length === 0 && !sessionLoading.value,
  (empty) => {
    if (empty && transcriptSearchOpen.value) closeTranscriptSearch();
  },
);
const chatDockStyle = computed(() => ({
  '--panes-scrollbar-width': `${panesScrollbarWidth.value}px`,
}));
const DOCK_VEIL_FADE_PX = 48;
const contentWrapStyle = computed(() => ({
  paddingBottom: `${dockHeight.value + DOCK_VEIL_FADE_PX}px`,
}));
type ComposerHandle = {
  loadForEdit: (value: string, snapshot?: ComposerDocumentSnapshot) => boolean | void;
  insertQuote?: (quote: string, comment?: string, source?: string) => boolean | void;
  insertPathMention?: (path: string, kind: 'file' | 'folder') => boolean | void;
  insertScreenshotAnnotation?: (file: File, comment: string) => boolean | void;
  addFiles?: (files: File[]) => boolean | void;
  hasInsertableComposer?: () => boolean;
  loadAttachmentsForEdit: (atts: TurnAttachment[]) => void;
  restoreDraftEntries?: (entries: AttachmentEntry[]) => void;
  focus: () => void;
  anyPopupOpen?: boolean;
  isEmpty?: () => boolean;
};
type RefArg = Element | (ComponentPublicInstance & Partial<ComposerHandle>) | null;

function toHtmlEl(el: RefArg): HTMLElement | null {
  if (el instanceof HTMLElement) return el;
  if (el && '$el' in el && el.$el instanceof HTMLElement) return el.$el;
  return null;
}

let panesGeomRaf = 0;

function updateDockHeight(): void {
  const dh = dockRef.value?.offsetHeight ?? 0;
  if (dh !== dockHeight.value) dockHeight.value = dh;
}

function updatePanesScrollbarWidth(): void {
  if (panesGeomRaf) return;
  panesGeomRaf = raf(() => {
    panesGeomRaf = 0;
    const el = panesRef.value;
    const sbw = el ? Math.max(0, el.offsetWidth - el.clientWidth) : 0;
    if (sbw !== panesScrollbarWidth.value) panesScrollbarWidth.value = sbw;
    updateDockHeight();
  });
}

function bindChatPane(el: RefArg): void {
  const node = toHtmlEl(el);
  if (node === panesRef.value) return;
  panesRef.value = node;
  if (node) rebindScrollObservers();
}

function bindChatDock(el: RefArg): void {
  const node = toHtmlEl(el);
  if (node === dockRef.value) return;
  dockRef.value = node ?? null;
  if (
    el &&
    'loadForEdit' in el && typeof el.loadForEdit === 'function' &&
    'focus' in el && typeof el.focus === 'function'
  ) {
    dockedComposerRef.value = {
      loadForEdit: el.loadForEdit.bind(el),
      insertQuote:
        'insertQuote' in el && typeof el.insertQuote === 'function'
          ? el.insertQuote.bind(el)
          : undefined,
      insertPathMention:
        'insertPathMention' in el && typeof el.insertPathMention === 'function'
          ? el.insertPathMention.bind(el)
          : undefined,
      insertScreenshotAnnotation:
        'insertScreenshotAnnotation' in el && typeof el.insertScreenshotAnnotation === 'function'
          ? el.insertScreenshotAnnotation.bind(el)
          : undefined,
      addFiles:
        'addFiles' in el && typeof el.addFiles === 'function'
          ? el.addFiles.bind(el)
          : undefined,
      hasInsertableComposer:
        'hasInsertableComposer' in el && typeof el.hasInsertableComposer === 'function'
          ? el.hasInsertableComposer.bind(el)
          : undefined,
      loadAttachmentsForEdit:
        'loadAttachmentsForEdit' in el && typeof el.loadAttachmentsForEdit === 'function'
          ? el.loadAttachmentsForEdit.bind(el)
          : () => {},
      restoreDraftEntries:
        'restoreDraftEntries' in el && typeof el.restoreDraftEntries === 'function'
          ? el.restoreDraftEntries.bind(el)
          : undefined,
      focus: el.focus.bind(el),
      get anyPopupOpen(): boolean {
        return 'anyPopupOpen' in el && el.anyPopupOpen === true;
      },
      isEmpty:
        'isEmpty' in el && typeof el.isEmpty === 'function' ? el.isEmpty.bind(el) : undefined,
    };
  } else {
    dockedComposerRef.value = null;
  }
  ensureDockObserved();
  updateDockHeight();
}

void bindChatPane;
void bindChatDock;

const following = ref(true);
const pillFar = ref(false);
const showPill = computed(() => !following.value && pillFar.value);
const panesScrolling = ref(false);
let panesScrollHideTimer: ReturnType<typeof setTimeout> | null = null;

const BOTTOM_THRESHOLD = 80;
const USER_ACTION_FOLLOW_LOCK_MS = 1000;

function distanceFromBottom(): number {
  const el = panesRef.value;
  if (!el) return 0;
  return lastObservedScrollHeight - lastScrollTop - lastObservedClientHeight;
}

let lastScrollTop = 0;
let userActionFollowUntil = 0;
let lastSmoothScroll = 0;
let searchScrollFollowSuppressUntil = 0;
let smoothScrollUntil = 0;
const SMOOTH_SCROLL_GUARD_MS = 420;
let stableFollowRaf = 0;
let stableFollowToken = 0;

function hasUserActionFollowLock(): boolean {
  return Date.now() < userActionFollowUntil;
}

let pillRaf = 0;

function livePillVisible(el: HTMLElement): boolean {
  return nextJumpPillVisible(pillFar.value, el.scrollHeight - el.scrollTop - el.clientHeight, el.clientHeight);
}

function syncPill(el: HTMLElement): void {
  if (nextJumpPillVisible(pillFar.value, distanceFromBottom(), lastObservedClientHeight) === pillFar.value) return;
  if (pillFar.value) {
    pillFar.value = livePillVisible(el);
    return;
  }
  if (pillRaf) return;
  pillRaf = raf(() => {
    pillRaf = raf(() => {
      pillRaf = 0;
      const pane = panesRef.value;
      if (pane) pillFar.value = livePillVisible(pane);
    });
  });
}

function onPanesScroll(): void {
  panesScrolling.value = true;
  if (panesScrollHideTimer) clearTimeout(panesScrollHideTimer);
  panesScrollHideTimer = setTimeout(() => {
    panesScrolling.value = false;
    panesScrollHideTimer = null;
  }, 900);
  const el = panesRef.value;
  if (!el) return;
  const top = el.scrollTop;
  syncPill(el);

  if (isPinned()) {
    lastScrollTop = top;
    return;
  }

  if (performance.now() - lastSmoothScroll < 100 || (following.value && !pointerHeld && stableFollowRaf)) {
    lastScrollTop = top;
    return;
  }

  const dist = lastObservedScrollHeight - top - lastObservedClientHeight;
  if (hasUserActionFollowLock()) {
    following.value = true;
    lastScrollTop = top;
    return;
  }
  if (top < lastScrollTop - 1 && dist > 1) {
    const liveDist = el.scrollHeight - top - el.clientHeight;
    if (liveDist > 1) {
      if (pointerHeld || liveDist > BOTTOM_THRESHOLD) following.value = false;
      else if (following.value) scheduleFollow();
    }
  } else if (
    dist <= BOTTOM_THRESHOLD &&
    top > lastScrollTop + 1 &&
    Date.now() >= searchScrollFollowSuppressUntil &&
    (following.value || el.scrollHeight - top - el.clientHeight <= BOTTOM_THRESHOLD)
  ) {
    following.value = true;
  }
  lastScrollTop = top;
  scheduleActiveTocUpdate();
}

function scrollToBottom(smooth = false): void {
  const el = panesRef.value;
  following.value = true;
  cancelTocSettleCorrection();
  if (!el) return;
  if (!smooth && performance.now() < smoothScrollUntil) return;
  if (smooth) {
    smoothScrollToBottom();
  } else {
    el.scrollTop = Math.max(el.scrollTop, el.scrollHeight - el.clientHeight);
  }
  lastScrollTop = el.scrollTop;
}

let smoothRaf = 0;

function smoothScrollToBottom(ms = 320): void {
  const el = panesRef.value;
  if (!el) return;
  if (smoothRaf) {
    cancelRaf(smoothRaf);
    smoothRaf = 0;
  }
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.scrollTop = el.scrollHeight;
    lastScrollTop = el.scrollTop;
    return;
  }
  const start = el.scrollTop;
  const t0 = performance.now();
  lastSmoothScroll = t0;
  smoothScrollUntil = t0 + ms + SMOOTH_SCROLL_GUARD_MS;
  const tick = () => {
    smoothRaf = 0;
    const p = Math.min(1, (performance.now() - t0) / ms);
    const ease = 1 - Math.pow(1 - p, 3);
    el.scrollTop = start + (el.scrollHeight - start) * ease;
    lastScrollTop = el.scrollTop;
    if (p < 1) {
      smoothRaf = raf(tick);
    } else {
      smoothScrollUntil = 0;
    }
  };
  smoothRaf = raf(tick);
}

type ScrollAnchor = { kind: 'turn' | 'tool'; id: string; top: number; messageId?: string };

function scrollAnchorTop(container: HTMLElement, node: HTMLElement): number {
  const inert = node.closest<HTMLElement>('[inert]');
  const positionNode = inert?.closest<HTMLElement>('.tool-group, .activity-run, .turn-fold') ?? node;
  return (
    positionNode.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop
  );
}

function findTopAnchors(
  container: HTMLElement,
  scrollTop: number,
): ScrollAnchor[] {
  const anchors = Array.from(
    container.querySelectorAll<HTMLElement>('.turn-anchor[data-turn-id], [data-scroll-anchor-id]'),
  ).map((node) => ({ node, top: scrollAnchorTop(container, node) }));
  const firstAfterTop = anchors.findIndex((anchor) => anchor.top >= scrollTop);
  const start = firstAfterTop < 0 ? Math.max(0, anchors.length - 1) : firstAfterTop;
  return anchors.slice(start, start + 2).flatMap((anchor) => {
    const toolId = anchor.node.dataset.scrollAnchorId;
    const id = toolId ?? anchor.node.dataset.turnId;
    return id ? [{ kind: toolId ? 'tool' : 'turn', id, top: anchor.top, messageId: anchor.node.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId }] : [];
  });
}

type HistoryScrollSnapshot = {
  anchors: ScrollAnchor[];
  oldHeight: number;
};

const pendingHistoryRestoreBySession = new Map<string, HistoryScrollSnapshot>();

function historyAnchorDelta(container: HTMLElement, snapshot: HistoryScrollSnapshot): number | null {
  for (const anchor of snapshot.anchors) {
    const attr = anchor.kind === 'tool' ? 'data-scroll-anchor-id' : 'data-turn-id';
    const newAnchor = container.querySelector<HTMLElement>(
      `[${attr}="${attrEscape(anchor.id)}"]`,
    );
    if (newAnchor) return scrollAnchorTop(container, newAnchor) - anchor.top;
  }
  return null;
}

function historyScrollDelta(container: HTMLElement, snapshot: HistoryScrollSnapshot): number {
  return historyAnchorDelta(container, snapshot) ?? container.scrollHeight - snapshot.oldHeight;
}

function restoreHistoryScroll(
  container: HTMLElement,
  snapshot: HistoryScrollSnapshot,
  currentTop: number,
): number {
  container.scrollTop = currentTop + historyScrollDelta(container, snapshot);
  lastScrollTop = container.scrollTop;
  return container.scrollTop;
}

async function handleLoadOlderMessages(): Promise<void> {
  if (
    !props.sessionId ||
    loadingMore.value ||
    historyLoadInProgress.value ||
    !hasMoreMessages.value
  ) {
    return;
  }
  const requestedSessionId = props.sessionId;
  const el = panesRef.value;
  const snapshot: HistoryScrollSnapshot = {
    anchors: el ? findTopAnchors(el, el.scrollTop) : [],
    oldHeight: el?.scrollHeight ?? 0,
  };

  setHistoryLoadInProgress(requestedSessionId, true);
  cancelScheduledFollow();
  try {
    await nextTick();
    await client.loadOlderMessages(requestedSessionId);
    await nextTick();

    if (props.sessionId !== requestedSessionId) {
      pendingHistoryRestoreBySession.set(requestedSessionId, snapshot);
      return;
    }

    const el2 = panesRef.value;
    if (!el2) return;

    if (!el2.querySelector('[data-virtual-scroll-root]')) restoreHistoryScroll(el2, snapshot, el2.scrollTop);
    pendingHistoryRestoreBySession.delete(requestedSessionId);
  } finally {
    setHistoryLoadInProgress(requestedSessionId, false);
  }
}

function attrEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replaceAll(/["\\]/g, '\\$&');
}

let tocSettleTimer: ReturnType<typeof setTimeout> | null = null;

function cancelTocSettleCorrection(): void {
  if (tocSettleTimer !== null) {
    clearTimeout(tocSettleTimer);
    tocSettleTimer = null;
  }
}

function settleTranscriptTarget(rect: () => DOMRect | undefined): void {
  cancelTocSettleCorrection();
  const until = performance.now() + 2000;
  const correct = () => {
    tocSettleTimer = null;
    const pane = panesRef.value;
    const target = rect();
    if (!pane || !target) return;
    const delta = target.top + target.height / 2 - (pane.getBoundingClientRect().top + pane.clientHeight / 2);
    if (Math.abs(delta) > 48) pane.scrollTop += delta;
    if (performance.now() < until) tocSettleTimer = setTimeout(correct, 120);
  };
  tocSettleTimer = setTimeout(correct, 480);
}

function revealTranscriptElement(target: HTMLElement): void {
  cancelActiveScrollWrites();
  following.value = false;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  settleTranscriptTarget(() => target.isConnected ? target.getBoundingClientRect() : undefined);
}

async function scrollToTurn(turnId: string): Promise<void> {
  const el = panesRef.value;
  if (!el) return;
  await chatPaneRef.value?.revealTurn(turnId);
  const target = el.querySelector<HTMLElement>(`.turn-anchor[data-turn-id="${attrEscape(turnId)}"]`);
  if (!target) return;
  revealTranscriptElement(target);
}

function scrollNestedContainersToRange(range: Range, pane: HTMLElement): void {
  const parent = range.startContainer.parentElement;
  if (parent === null) return;
  for (let node: Element | null = parent; node !== null && node !== pane; node = node.parentElement) {
    const style = getComputedStyle(node);
    const canScrollY = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
    const canScrollX = /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
    if (!canScrollY && !canScrollX) continue;
    const rect = range.getClientRects()[0];
    if (!rect) return;
    const nodeRect = node.getBoundingClientRect();
    if (canScrollY) {
      node.scrollTop += (rect.top + rect.height / 2) - (nodeRect.top + node.clientHeight / 2);
    }
    if (canScrollX) {
      node.scrollLeft += (rect.left + rect.width / 2) - (nodeRect.left + node.clientWidth / 2);
    }
  }
}

function revealTranscriptRange(range: Range): void {
  const el = panesRef.value;
  if (!el) return;
  const parent = range.startContainer.parentElement;
  cancelActiveScrollWrites();
  following.value = false;
  searchScrollFollowSuppressUntil = Date.now() + 700;
  const clampWrap = parent?.closest('.u-text-wrap.is-clamped');
  if (clampWrap) {
    clampWrap.querySelector<HTMLElement>('.u-text-toggle')?.click();
    void nextTick(() => revealTranscriptRangeAfterExpand(range, el));
    return;
  }
  revealTranscriptRangeAfterExpand(range, el);
}

function revealTranscriptRangeAfterExpand(range: Range, el: HTMLElement): void {
  const parent = range.startContainer.parentElement;
  scrollNestedContainersToRange(range, el);
  const rect = range.getClientRects()[0];
  if (!rect) {
    if (parent instanceof HTMLElement) revealTranscriptElement(parent);
    return;
  }
  const paneRect = el.getBoundingClientRect();
  const centerDelta = (rect.top + rect.height / 2) - (paneRect.top + el.clientHeight / 2);
  const smooth =
    typeof window === 'undefined' ||
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollTo({ top: el.scrollTop + centerDelta, behavior: smooth ? 'smooth' : 'auto' });
  settleTranscriptTarget(() => range.startContainer.isConnected ? range.getClientRects()[0] : undefined);
}

function currentLayoutKey(): string {
  const el = panesRef.value;
  if (!el) return 'none';
  const content = el.firstElementChild;
  const contentHeight = content instanceof HTMLElement ? content.offsetHeight : 0;
  const dockHeight = dockRef.value?.offsetHeight ?? 0;
  return `${el.scrollHeight}:${el.clientHeight}:${contentHeight}:${dockHeight}`;
}

function raf(cb: () => void): number {
  return (typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(cb)
    : setTimeout(cb, 16)) as unknown as number;
}

function cancelRaf(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id);
}

let pinUntil = 0;
let pinRaf = 0;
let pinEl: HTMLElement | null = null;
let pinTargetTop = 0;

function isPinned(): boolean {
  return performance.now() < pinUntil;
}

function pinScrollFor(el: HTMLElement, ms = 200): void {
  const panes = panesRef.value;
  if (!panes) return;
  if (historyLoadInProgress.value) return;
  cancelActiveScrollWrites();
  following.value = false;
  pinEl = el;
  pinTargetTop = el.getBoundingClientRect().top;
  pinUntil = performance.now() + ms;
  if (pinRaf) return;
  const tick = () => {
    pinRaf = 0;
    if (!pinEl) return;
    if (following.value) {
      pinEl = null;
      return;
    }
    if (performance.now() >= pinUntil) {
      pinEl = null;
      settleAfterPin();
      return;
    }
    const delta = pinEl.getBoundingClientRect().top - pinTargetTop;
    if (delta) panes.scrollTop += delta;
    pinRaf = raf(tick);
  };
  pinRaf = raf(tick);
}

function settleAfterPin(): void {
  following.value = distanceFromBottom() <= BOTTOM_THRESHOLD;
}

function stabilizeAnchorForRestore(el: HTMLElement): void {
  const panes = panesRef.value;
  if (!panes || historyLoadInProgress.value) {
    liftSessionSettle();
    return;
  }
  following.value = false;
  pinEl = el;
  pinTargetTop = el.getBoundingClientRect().top;
  pinUntil = performance.now() + 1200;
  let lastKey = '';
  let stableFrames = 0;
  const finish = () => {
    pinEl = null;
    pinUntil = 0;
    settleAfterPin();
    liftSessionSettle();
  };
  const tick = () => {
    pinRaf = 0;
    if (!pinEl) return;
    if (following.value) {
      pinEl = null;
      pinUntil = 0;
      return;
    }
    if (!sessionSettling.value) {
      pinEl = null;
      pinUntil = 0;
      settleAfterPin();
      return;
    }
    if (performance.now() >= pinUntil) {
      finish();
      return;
    }
    const delta = pinEl.getBoundingClientRect().top - pinTargetTop;
    if (delta) panes.scrollTop += delta;
    const key = currentLayoutKey();
    stableFrames = delta === 0 && key === lastKey ? stableFrames + 1 : 0;
    lastKey = key;
    if (stableFrames >= 3) {
      finish();
      return;
    }
    pinRaf = raf(tick);
  };
  if (pinRaf) cancelRaf(pinRaf);
  pinRaf = raf(tick);
}

function scheduleStableFollow(maxFrames = 36, onDone?: () => void): void {
  if (!following.value && !hasUserActionFollowLock()) {
    onDone?.();
    return;
  }
  const token = ++stableFollowToken;
  let lastKey = '';
  let stableFrames = 0;
  let frames = 0;
  if (stableFollowRaf) {
    cancelRaf(stableFollowRaf);
    stableFollowRaf = 0;
  }

  const tick = () => {
    stableFollowRaf = 0;
    if (token !== stableFollowToken) return;
    if (!following.value && !hasUserActionFollowLock()) {
      onDone?.();
      return;
    }
    scrollToBottom(false);
    const key = currentLayoutKey();
    stableFrames = key === lastKey ? stableFrames + 1 : 0;
    lastKey = key;
    frames++;
    if (stableFrames < 3 && frames < maxFrames) {
      stableFollowRaf = raf(tick);
    } else {
      onDone?.();
    }
  };

  stableFollowRaf = raf(tick);
}

type ScrollKey = {
  length: number;
  firstId: string;
  lastId: string;
  lastTextLen: number;
  lastThinkingLen: number;
  lastToolsLen: number;
  approvalIds: string;
};

function isHistoryPrependOnly(prev: ScrollKey | undefined, next: ScrollKey): boolean {
  return (
    prev !== undefined &&
    prev.length > 0 &&
    next.length >= prev.length &&
    prev.firstId !== next.firstId &&
    prev.lastId === next.lastId &&
    prev.lastTextLen === next.lastTextLen &&
    prev.lastThinkingLen === next.lastThinkingLen &&
    prev.lastToolsLen === next.lastToolsLen &&
    prev.approvalIds === next.approvalIds
  );
}

const scrollKey = computed<ScrollKey>(() => {
  const approvalIds = approvals.value.map((a) => a.approvalId).join(',');
  const t = turns.value;
  const last = t.at(-1);
  const thinkingLen = last?.thinking?.length ?? 0;
  const toolsLen =
    last?.tools?.reduce(
      (n, tool) => n + tool.name.length + (tool.arg?.length ?? 0) + (tool.output?.join('').length ?? 0),
      0,
    ) ?? 0;
  return {
    length: t.length,
    firstId: t[0]?.id ?? '',
    lastId: last?.id ?? '',
    lastTextLen: last?.text.length ?? 0,
    lastThinkingLen: thinkingLen,
    lastToolsLen: toolsLen,
    approvalIds,
  };
});

let scrollKeySession: string | number | undefined = props.sessionId;

watch(scrollKey, async (next, prev) => {
  const sid = props.sessionId;
  const crossSession = sid !== scrollKeySession;
  scrollKeySession = sid;
  if (historyLoadInProgress.value && isHistoryPrependOnly(prev, next)) {
    scheduleActiveTocUpdate();
    return;
  }
  if (crossSession || sessionSettling.value) {
    scheduleActiveTocUpdate();
    return;
  }
  await nextTick();
  if (following.value || hasUserActionFollowLock()) {
    scrollToBottom(next.length < prev.length);
  }
  scheduleActiveTocUpdate();
});

watch(dockRef, () => {
  ensureDockObserved();
});

watch(
  () => props.mobile,
  async () => {
    await nextTick();
    updatePanesScrollbarWidth();
  },
);

const scrollStateBySession = new Map<string, { top: number; following: boolean; anchor?: ScrollAnchor }>();

const sessionSettling = ref(false);
let settleLiftRaf = 0;
let settleLiftTimer: ReturnType<typeof setTimeout> | null = null;

function beginSessionSettle(): void {
  sessionSettling.value = true;
  if (settleLiftRaf) {
    cancelRaf(settleLiftRaf);
    settleLiftRaf = 0;
  }
  if (settleLiftTimer) clearTimeout(settleLiftTimer);
  settleLiftTimer = setTimeout(() => {
    sessionSettling.value = false;
    settleLiftTimer = null;
  }, 1200);
}

function liftSessionSettle(): void {
  if (!sessionSettling.value) return;
  let framesLeft = 2;
  const step = (): void => {
    settleLiftRaf = 0;
    framesLeft--;
    if (framesLeft > 0) {
      settleLiftRaf = raf(step);
      return;
    }
    sessionSettling.value = false;
    if (settleLiftTimer) {
      clearTimeout(settleLiftTimer);
      settleLiftTimer = null;
    }
  };
  if (settleLiftRaf) cancelRaf(settleLiftRaf);
  settleLiftRaf = raf(step);
}

let restoreGeneration = 0;

async function restoreSessionScroll(sessionKey: string | undefined): Promise<void> {
  const gen = ++restoreGeneration;
  beginSessionSettle();
  await nextTick();
  if (gen !== restoreGeneration || props.sessionId !== sessionKey) return;
  updateDockHeight();
  const el2 = panesRef.value;
  const saved = sessionKey ? scrollStateBySession.get(String(sessionKey)) : undefined;
  if (saved && el2) {
    following.value = saved.following;
    const pendingRestore = pendingHistoryRestoreBySession.get(String(sessionKey));
    let top = pendingRestore
      ? restoreHistoryScroll(el2, pendingRestore, saved.top)
      : saved.top;
    let savedAnchor: HTMLElement | null = null;
    if (!saved.following && saved.anchor) {
      await chatPaneRef.value?.revealTurn(saved.anchor.messageId ?? saved.anchor.id);
      if (gen !== restoreGeneration || props.sessionId !== sessionKey) return;
      if (saved.anchor.kind === 'tool') {
        el2.scrollTop = top;
        await new Promise<void>(resolve => raf(() => raf(() => resolve())));
        await nextTick();
        if (gen !== restoreGeneration || props.sessionId !== sessionKey) return;
      }
      const attr = saved.anchor.kind === 'tool' ? 'data-scroll-anchor-id' : 'data-turn-id';
      const anchor = el2.querySelector<HTMLElement>(`[${attr}="${attrEscape(saved.anchor.id)}"]`);
      if (anchor) {
        savedAnchor = anchor;
        top = scrollAnchorTop(el2, anchor) - saved.anchor.top;
      }
    }
    if (pendingRestore && sessionKey) pendingHistoryRestoreBySession.delete(String(sessionKey));
    following.value = saved.following;
    el2.scrollTop = top;
    lastScrollTop = el2.scrollTop;
    syncPill(el2);
    if (saved.following) {
      scheduleStableFollow(36, liftSessionSettle);
    } else {
      if (savedAnchor) stabilizeAnchorForRestore(savedAnchor);
      else liftSessionSettle();
    }
  } else {
    following.value = true;
    lastScrollTop = 0;
    scrollToBottom(false);
    scheduleStableFollow(36, liftSessionSettle);
  }
  markTocAnchorsDirty();
  updateActiveTocQuery();
}

watch(
  () => props.sessionId,
  async (newKey, oldKey) => {
    const el = panesRef.value;
    if (oldKey && el) {
      const anchor = findTopAnchors(el, el.scrollTop)[0];
      scrollStateBySession.set(String(oldKey), {
        top: el.scrollTop,
        following: following.value,
        anchor: anchor ? { ...anchor, top: anchor.top - el.scrollTop } : undefined,
      });
    }
    cancelActiveScrollWrites();
    pillFar.value = false;
    if (sessionLoading.value) {
      following.value = (newKey ? scrollStateBySession.get(String(newKey))?.following : undefined) ?? true;
      beginSessionSettle();
      return;
    }
    await restoreSessionScroll(newKey);
  },
);

watch(
  () => sessionLoading.value,
  async (loading, was) => {
    if (loading) {
      beginSessionSettle();
      return;
    }
    if (!was) return;
    await restoreSessionScroll(props.sessionId);
  },
  { immediate: true },
);

watch(
  () => turnActive.value,
  async (now, was) => {
    if (now || !was) return;
    if (!following.value && !hasUserActionFollowLock()) return;
    await nextTick();
    scheduleStableFollow(48);
    scheduleActiveTocUpdate();
  },
);

function followAfterUserAction(): void {
  following.value = true;
  userActionFollowUntil = Date.now() + USER_ACTION_FOLLOW_LOCK_MS;
  void nextTick(() => {
    scrollToBottom(true);
    scheduleStableFollow(16);
  });
}

function handleComposerSubmit(payload: { text: string; attachments: PromptAttachment[]; restoreText?: string; editText?: string; restoreEntries?: AttachmentEntry[]; snapshot?: ComposerDocumentSnapshot; skills?: { name: string; path?: string }[]; forceQueue?: boolean }): void {
  followAfterUserAction();
  emit('submit', payload);
}

function handleComposerSteer(payload: { text: string; attachments: PromptAttachment[]; restoreText?: string; restoreEntries?: AttachmentEntry[]; snapshot?: ComposerDocumentSnapshot; skills?: { name: string; path?: string }[] }): void {
  followAfterUserAction();
  emit('steer', payload);
}

function handleComposerCommand(payload: { cmd: string; attachments: PromptAttachment[]; restoreText?: string; skillName?: string; skillPath?: string; restoreEntries?: AttachmentEntry[]; snapshot?: ComposerDocumentSnapshot; editText?: string; delivery?: 'steer' | 'queue' }): void {
  if (payload.delivery !== undefined) followAfterUserAction();
  emit('command', payload);
}

function handleEditMessage(payload: {
  text: string;
  attachments?: TurnAttachment[];
  snapshot?: ComposerDocumentSnapshot;
  turnId: string;
}): void {
  following.value = true;
  userActionFollowUntil = Date.now() + USER_ACTION_FOLLOW_LOCK_MS;
  emit('editMessage', { ...payload, text: reviveQuoteBlockLinks(payload.text) });
}

function handleEditQueued(index: number): void {
  const item = props.queued?.[index];
  const text = item?.editText ?? item?.text ?? '';
  const loaded = loadComposerForEdit(text, item?.attachments, undefined, parseComposerSnapshot(item?.snapshot) ?? undefined);
  if (loaded) client.unqueue(index);
}

function handleReorderQueue(payload: { from: number; to: number }): void {
  void client.reorderQueue(payload.from, payload.to);
}

function handleQuestionAnswer(qid: string, resp: QuestionResponse): void {
  followAfterUserAction();
  void client.respondQuestion(qid, resp);
}

function handleApproval(
  id: string | undefined,
  response: { decision: 'approved' | 'rejected' | 'cancelled'; scope?: 'session'; feedback?: string } | undefined,
): void {
  if (!id || !response) return;
  void client.respondApproval(id, response);
}

let contentObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let observedContent: Element | null = null;
let observedDock: HTMLElement | null = null;
let lastObservedScrollHeight = 0;
let lastObservedClientHeight = 0;
let scrollRaf = 0;
const historyLoadingSessions = ref<ReadonlySet<string>>(new Set());
const historyLoadInProgress = computed(
  () => !!props.sessionId && historyLoadingSessions.value.has(props.sessionId),
);

function setHistoryLoadInProgress(sessionId: string, inProgress: boolean): void {
  const next = new Set(historyLoadingSessions.value);
  if (inProgress) next.add(sessionId);
  else next.delete(sessionId);
  historyLoadingSessions.value = next;
}

function scheduleFollow(): void {
  if (historyLoadInProgress.value) return;
  if (scrollRaf) return;
  scrollRaf = raf(() => {
    scrollRaf = 0;
    if (historyLoadInProgress.value) return;
    if (isPinned()) return;
    if (following.value || hasUserActionFollowLock()) scrollToBottom(false);
  });
}

function followNow(): void {
  if (following.value && !historyLoadInProgress.value) scrollToBottom(false);
  else scheduleFollow();
}

function cancelScheduledFollow(): void {
  stableFollowToken++;
  if (stableFollowRaf) {
    cancelRaf(stableFollowRaf);
    stableFollowRaf = 0;
  }
  if (scrollRaf) {
    cancelRaf(scrollRaf);
    scrollRaf = 0;
  }
}

function cancelActiveScrollWrites(): void {
  ++restoreGeneration;
  const el = panesRef.value;
  if (el) pendingHistoryScrolls.delete(el);

  userActionFollowUntil = 0;
  searchScrollFollowSuppressUntil = 0;
  cancelScheduledFollow();
  pinUntil = 0;
  pinEl = null;
  if (smoothRaf) {
    cancelRaf(smoothRaf);
    smoothRaf = 0;
  }
  cancelTocSettleCorrection();

  if (el) {
    const top = el.scrollTop;
    if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'auto' });
    else el.scrollTop = top;
  }
  smoothScrollUntil = 0;
  lastSmoothScroll = Number.NEGATIVE_INFINITY;
  if (el) lastScrollTop = el.scrollTop;
  liftSessionSettle();
}

function stopFollowingForUserIntent(): void {
  const el = panesRef.value;
  if (!el || (el.scrollHeight - el.clientHeight <= 1 && !hasMoreMessages.value && !sessionSettling.value && !isPinned())) return;

  following.value = false;
  cancelActiveScrollWrites();
}

function upwardScrollStaysNested(event: Event): boolean {
  const pane = panesRef.value;
  return pane !== null && nestedScrollerTakesUpwardScroll(event.composedPath(), pane);
}

function onPanesWheel(event: WheelEvent): void {
  if (event.defaultPrevented || event.ctrlKey || event.shiftKey) return;
  cancelTocSettleCorrection();
  if (event.deltaY > 0) {
    if (sessionSettling.value || isPinned()) cancelActiveScrollWrites();
    const el = panesRef.value;
    if (el && !following.value && distanceFromBottom() <= 1 && el.scrollHeight - el.scrollTop - el.clientHeight <= 1) {
      following.value = true;
    }
    return;
  }
  if (event.deltaY === 0 || upwardScrollStaysNested(event)) return;
  stopFollowingForUserIntent();
}

let pointerHeld = false;

function releasePointer(): void {
  pointerHeld = false;
}

function onPanesPointerDown(event: PointerEvent): void {
  pointerHeld = true;
  const el = panesRef.value;
  if (!el || event.defaultPrevented || event.button !== 0 || event.pointerType === 'touch') return;
  const rect = el.getBoundingClientRect();
  const gutterWidth = el.offsetWidth - el.clientWidth;
  const hitWidth = gutterWidth > 0 ? gutterWidth : 12;
  if (event.target === el && event.clientX >= rect.right - hitWidth) {
    stopFollowingForUserIntent();
  }
}

let lastTouchY: number | null = null;

function onPanesTouchStart(event: TouchEvent): void {
  lastTouchY = event.touches.length === 1 ? event.touches[0]!.clientY : null;
}

function onPanesTouchMove(event: TouchEvent): void {
  const y = event.touches.length === 1 ? event.touches[0]!.clientY : null;
  cancelTocSettleCorrection();
  if (y !== null && lastTouchY !== null) {
    if (y < lastTouchY - 2) {
      if (sessionSettling.value || isPinned()) cancelActiveScrollWrites();
    } else if (y > lastTouchY + 2 && !upwardScrollStaysNested(event)) {
      stopFollowingForUserIntent();
    }
  }
  lastTouchY = y;
}

function ensureContentObserved(): void {
  if (!resizeObserver) return;
  const el = panesRef.value?.firstElementChild ?? null;
  if (el === observedContent) return;
  if (observedContent) resizeObserver.unobserve(observedContent);
  observedContent = el;
  if (el) resizeObserver.observe(el);
}

function ensureDockObserved(): void {
  if (!resizeObserver) return;
  const el = dockRef.value;
  if (el === observedDock) return;
  if (observedDock) resizeObserver.unobserve(observedDock);
  observedDock = el;
  if (el) resizeObserver.observe(el);
}

function rebindScrollObservers(): void {
  const el = panesRef.value;
  updatePanesScrollbarWidth();
  if (contentObserver) {
    contentObserver.disconnect();
    if (el) contentObserver.observe(el, { childList: true, subtree: true, characterData: true });
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    observedContent = null;
    observedDock = null;
    if (el) resizeObserver.observe(el);
    ensureContentObserved();
    ensureDockObserved();
  }
  lastObservedScrollHeight = el?.scrollHeight ?? 0;
  lastObservedClientHeight = el?.clientHeight ?? 0;
  syncWideTableToc();
  markTocAnchorsDirty();
}

function onContentMutated(): void {
  ensureContentObserved();
  scheduleFollow();
  syncWideTableToc();
}

function onVisibilityChange(): void {
  if (typeof document === 'undefined') return;
  if (document.visibilityState === 'visible' && following.value) {
    scheduleStableFollow();
  }
}

const interruptedTurnId = computed<string | null>(() => {
  if (turnEnd.value?.outcome !== 'interrupted' || props.working || turnActive.value) return null;
  const last = turns.value[turns.value.length - 1];
  return last?.role === 'assistant' && turnHasOutput(last) ? last.id : null;
});

const turnFailed = computed<boolean>(
  () =>
    turnEnd.value?.outcome === 'failed' &&
    !props.working &&
    !turnActive.value &&
    turns.value.length > 0,
);

function handleResumeTurn(): void {
  if (!gateSubmit()) return;
  followAfterUserAction();
  emit('submit', { text: t('conversation.turnFailedResumeText'), attachments: [] });
}

function handleForkTurn(payload: { turnIndex: number }): void {
  if (!props.sessionId) return;
  void client.forkSession(props.sessionId, payload.turnIndex);
}

const forkPending = computed(
  () =>
    props.sessionId !== undefined &&
    sessionRuntimeStore().forkInFlightBySession[props.sessionId] === true,
);

const { armed: escInterruptArmed, press: pressEscInterrupt, reset: resetEscInterrupt } = useEscInterrupt({
  sessionId: () => props.sessionId,
  working: () => props.working,
  interrupt: handleInterrupt,
});

function handleInterrupt(): void {
  resetEscInterrupt();
  emit('interrupt');
}

function composerPopupOpen(): boolean {
  return (dockedComposerRef.value?.anyPopupOpen ?? emptyComposerRef.value?.anyPopupOpen) === true;
}

const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

let lastPointerTarget: EventTarget | null = null;
function onDocumentPointerDown(event: PointerEvent): void {
  lastPointerTarget = event.target;
}

function onTranscriptSelectionChange(): void {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed) historySelection.value = false;
}

async function selectAllRegion(target: EventTarget | null): Promise<void> {
  const attended = target instanceof Element && target !== document.body ? target : lastPointerTarget;
  const panel = closestRegion(attended, '.global-preview');
  if (panel) {
    selectContentsOf(panel);
    return;
  }
  historySelection.value = true;
  await nextTick();
  const chat = panesRef.value?.querySelector('.chat');
  if (chat) selectContentsOf(chat);
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.target instanceof Element && event.target.closest('.terminal-host') !== null) {
    return;
  }
  const scrollDirection = scrollKeyDirection(event);
  if (
    scrollDirection !== 0 &&
    !event.defaultPrevented && !isComposingKeyEvent(event) &&
    !anyOverlayOpen.value && !composerPopupOpen() && !isEditableTarget(event.target) &&
    event.target instanceof Element &&
    (panesRef.value?.contains(event.target) || event.target === document.body) &&
    (event.key !== ' ' || !event.target.closest('button, a[href], select, summary, [role="button"]'))
  ) {
    if (scrollDirection < 0) stopFollowingForUserIntent();
    else if (!following.value) cancelActiveScrollWrites();
  }
  if (
    event.key === 'Escape' &&
    !anyOverlayOpen.value &&
    !composerPopupOpen() &&
    !event.defaultPrevented &&
    !event.repeat &&
    !isComposingKeyEvent(event)
  ) {
    if (props.working) {
      event.preventDefault();
      pressEscInterrupt();
    }
    return;
  }
  if (isFindKeyEvent(event) && !anyOverlayOpen.value && turns.value.length > 0) {
    event.preventDefault();
    openTranscriptSearch();
    return;
  }
  if (isSelectAllKeyEvent(event) && !anyOverlayOpen.value && !isEditableTarget(event.target)) {
    event.preventDefault();
    selectAllRegion(event.target);
  }
}

function onVisualViewportResize(): void {
  if (following.value) scheduleFollow();
}

onMounted(() => {
  document.addEventListener('selectionchange', onTranscriptSelectionChange);
  nextTick(() => {
    if (typeof MutationObserver === 'function') {
      contentObserver = new MutationObserver(onContentMutated);
    }
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver((entries) => {
        markTocAnchorsDirty();
        updatePanesScrollbarWidth();
        if (entries.some((entry) => entry.target === dockRef.value)) updateDockHeight();
        const el = panesRef.value;
        if (!el) return;
        const { scrollHeight, clientHeight } = el;
        const grew = scrollHeight > lastObservedScrollHeight + 1;
        const viewportShrank = clientHeight < lastObservedClientHeight - 1;
        lastObservedScrollHeight = scrollHeight;
        lastObservedClientHeight = clientHeight;
        if (!isPinned() && (grew || viewportShrank)) followNow();
        syncPill(el);
      });
    }
    rebindScrollObservers();
    if (!sessionLoading.value) scheduleStableFollow(48);
    updateActiveTocQuery();
    panesRef.value?.addEventListener('kimi-table-layout', onTableLayout);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('pointerdown', onDocumentPointerDown, true);
      document.addEventListener('pointerup', releasePointer, true);
      document.addEventListener('pointercancel', releasePointer, true);
      document.addEventListener('compositionstart', handleCompositionStart);
      document.addEventListener('compositionend', handleCompositionEnd);
    }
    window.visualViewport?.addEventListener('resize', onVisualViewportResize);
  });
});

onUnmounted(() => {
  document.removeEventListener('selectionchange', onTranscriptSelectionChange);
  panesRef.value?.removeEventListener('kimi-table-layout', onTableLayout);
  if (contentObserver) contentObserver.disconnect();
  if (resizeObserver) resizeObserver.disconnect();
  if (scrollRaf) cancelRaf(scrollRaf);
  if (stableFollowRaf) cancelRaf(stableFollowRaf);
  if (pinRaf) cancelRaf(pinRaf);
  if (smoothRaf) cancelRaf(smoothRaf);
  if (pillRaf) cancelRaf(pillRaf);
  if (activeTocRaf) cancelRaf(activeTocRaf);
  if (tocSettleTimer !== null) clearTimeout(tocSettleTimer);
  if (panesScrollHideTimer) clearTimeout(panesScrollHideTimer);
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('pointerup', releasePointer, true);
    document.removeEventListener('pointercancel', releasePointer, true);
    document.removeEventListener('compositionstart', handleCompositionStart);
    document.removeEventListener('compositionend', handleCompositionEnd);
  }
  window.visualViewport?.removeEventListener('resize', onVisualViewportResize);
});

function focusComposer(): void {
  (dockedComposerRef.value ?? emptyComposerRef.value)?.focus();
}

useComposerAutoFocus({
  sessionId: () => props.sessionId,
  mobile: () => props.mobile === true,
  starting: () => starting.value,
  dockedComposer: dockedComposerRef,
  emptyComposer: emptyComposerRef,
});

function notifyUndone(): void {
  toast({ layout: 'bar', mode: 'replace', variant: 'success', title: t('conversation.undone'), duration: 3000 });
}

const showEmptyToggles = computed(
  () => !props.mobile && turns.value.length === 0 && !sessionLoading.value,
);

defineExpose({ loadComposerForEdit, insertComposerQuote, insertComposerPathMention, insertScreenshotAnnotation, addComposerFiles, hasInsertableComposer, isComposerEmpty, focusComposer, notifyUndone, selectAllRegion, focusGoal, closeDockPanel, composerPopupOpen });
</script>

<template>
  <section ref="conversationRootRef" class="con" :class="{ mobile }">
    <ChatHeader
      v-if="!mobile && !(turns.length === 0 && !sessionLoading)"
      :session-info-enabled="sessionInfoPanelVisible"
      :session-info-disabled="wideTableActive"
      @copy-all="(onCopied) => chatPaneRef?.copyConversation(onCopied)"
      @copy-final-summary="(onCopied) => chatPaneRef?.copyFinalSummary(onCopied)"
      @toggle-pin="(id) => emit('togglePin', id)"
      @toggle-session-info="toggleSessionInfo"
    />
    <div
      v-else-if="!mobile"
      class="empty-drag"
      :class="{ 'macos-desktop': isMacosDesktop }"
    />
    <ViewToggles v-if="showEmptyToggles" class="empty-toggles" />

    <ConversationToc
      :items="conversationTocItems"
      :session-id="sessionId"
      :active-turn-id="activeTurnId"
      :mobile="mobile"
      :session-loading="sessionLoading"
      :table-expanded="wideTableActive"
      :window-history="!mobile && turns.length > 40"
      @select="scrollToTurn"
    />

    <div class="chat-layout">
      <div class="chat-main">
      <div
        :ref="bindChatPane"
        class="panes chat-scroll"
        :class="{
          'is-following': following,
          scrolling: panesScrolling,
          'session-settling': sessionSettling,
        }"
        @scroll.passive="onPanesScroll"
        @wheel.passive="onPanesWheel"
        @pointerdown.passive="onPanesPointerDown"
        @touchstart.passive="onPanesTouchStart"
        @touchmove.passive="onPanesTouchMove"
      >
        <div class="content-wrap" :class="[mobile ? 'align-mobile' : 'align-center']" :style="contentWrapStyle">
          <template v-if="turns.length === 0 && !sessionLoading">
            <div class="empty-spacer" />
            <WorkspaceHome
              v-if="showWorkspaceHome"
              :workspace-name="activeWorkspaceLabel"
              :workspace-root="workspaceRoot"
              :workspace-dirs="workspaceDirs"
              :workspace-host-id="activeHostId"
            />
            <div v-else class="empty-hint">
              <KimiCodeWordmark v-if="!starting" class="empty-logo" />
              <span v-else class="empty-hint-title is-starting">
                <Spinner size="sm" />
                <span>{{ t('conversation.starting') }}</span>
              </span>
            </div>
            <div v-if="!starting" class="ws-pill-row">
              <div v-if="hasWorkspaces" class="ws-anchor">
                <Tooltip :text="t('conversation.switchWorkspace')">
                  <button
                    type="button"
                    class="ws-chip"
                    :class="{ open: wsPickOpen }"
                    :aria-expanded="wsPickOpen"
                    @click.stop="toggleWsPick"
                  >
                    <WorkspaceIcon :host-id="activeHostId" status="all" />
                    <span class="ws-chip-name">{{ activeWorkspaceLabel }}</span>
                    <Icon class="ws-chip-chev" name="chevron-down" size="sm" />
                  </button>
                </Tooltip>
                <div
                  v-if="wsPickOpen"
                  ref="wsPanelRef"
                  class="ws-panel"
                  :class="{ up: wsPickUp }"
                  :style="wsPickMaxHeight ? { maxHeight: wsPickMaxHeight } : undefined"
                  role="menu"
                >
                  <div class="ws-search">
                    <Icon name="search" size="sm" />
                    <input
                      ref="wsSearchInputRef"
                      v-model="workspaceQuery"
                      class="ws-search-input"
                      type="text"
                      :placeholder="t('workspace.projectSearchPlaceholder')"
                      :aria-label="t('workspace.projectSearchPlaceholder')"
                      autocomplete="off"
                      @click.stop
                      @keydown.stop
                    />
                  </div>
                  <div class="ws-list">
                    <button
                      v-for="w in filteredWorkspaces"
                      :key="w.id"
                      type="button"
                      class="ws-row"
                      :class="{ on: w.id === activeWorkspaceId }"
                      :disabled="hostsStore().blocked(w.hostId)"
                      role="menuitem"
                      @click.stop="pickWorkspace(w.id)"
                    >
                      <WorkspaceIcon :host-id="w.hostId" status="all" />
                      <span class="ws-info">
                        <span class="ws-name">{{ w.name }}</span>
                        <span class="ws-path">{{ hostsStore().workspacePathLabel(w, t) }}</span>
                      </span>
                      <Icon v-if="w.id === activeWorkspaceId" class="ws-check" name="check" size="sm" />
                    </button>
                    <div v-if="filteredWorkspaces.length === 0" class="ws-empty">
                      {{ t('workspace.projectSearchNoResults') }}
                    </div>
                  </div>
                  <div class="ws-divider" />
                  <button
                    type="button"
                    class="ws-action"
                    role="menuitem"
                    @click.stop="wsPickOpen = false; emit('addWorkspace')"
                  >
                    <Icon name="folder-plus" />
                    <span>{{ t('conversation.addWorkspace') }}</span>
                  </button>
                </div>
              </div>
              <button v-else type="button" class="ws-chip ws-ghost" @click="emit('addWorkspace')">
                <Icon name="folder-plus" />
                <span>{{ t('conversation.addWorkspace') }}</span>
              </button>
              <HostNotice class="empty-host-notice" :host-id="activeHostId" />
              <KimiMascotPeek ref="mascotRef" class="ws-mascot" />
            </div>
            <Composer
              ref="emptyComposerRef"
              :interrupt-armed="escInterruptArmed"
              class="empty-composer"
              hide-context
              :before-submit="gateSubmit"
              :on-capture-screenshot="captureScreenshotAction"
              :screenshot-shortcut-keys="screenshotShortcutKeys"
              :screenshot-shortcut-unavailable="!!osGlobalFailures.captureScreenshot"
              :screenshot-shortcut-failure-reason="osGlobalFailures.captureScreenshot"
              :on-configure-screenshot-shortcut="configureScreenshotShortcut"
              @submit="handleComposerSubmit"
              @steer="handleComposerSteer"
              @steer-queued="emit('steerQueued', $event)"
              @command="handleComposerCommand"
              @interrupt="handleInterrupt"
              @focus-goal="focusGoal"
              @pick-model="emit('pickModel')"
              @login="emit('login')"
              @configure-model="emit('configureModel')"
            />
            <!-- Backdrop must live outside the composer card (container-type
                 captures position:fixed). -->
            <div v-if="wsPickOpen" class="ws-backdrop" @click="wsPickOpen = false" />
            <!-- The lower spacer hosts the recent sessions: the hero keeps its
                 fixed vertical middle whether or not the list exists. -->
            <div class="empty-spacer empty-tail">
              <WorkspaceRecentSessions
                v-if="showWorkspaceHome && recentSessions.length > 0"
                :sessions="recentSessions"
              />
            </div>
          </template>
          <template v-else>
            <ErrorBoundary>
            <ChatPane
              ref="chatPaneRef"
              :key="sessionId ?? 'no-session'"
              :session-id="sessionId"
              :fork-enabled="sessionId !== undefined"
              :fork-pending="forkPending"
              :turns="turns"
              :window-history="true"
              :history-state="historyState"
              :render-all-history="(!mobile && !hasMoreMessages && !activeSessionPaged && historyRenderAllAffordable(turns)) || transcriptSearchOpen || historySelection"
              :cwd="status.cwd"
              :approvals="approvals"
              :questions="questions"
              :turn-active="turnActive"
              :working="working"
              :session-loading="sessionLoading"
              :compaction="compaction"
              :has-more-messages="hasMoreMessages"
              :loading-more="loadingMore"
              :loading-more-error="loadingMoreError"
              :is-following="following"
              :queued="queued"
              :interrupted-turn-id="interruptedTurnId"
              :turn-failed="turnFailed"
              :turn-error="turnError"
              :turn-retry="turnRetry"
              @resume-turn="handleResumeTurn"
              @fork-turn="handleForkTurn"
              @open-media="emit('openMedia', $event)"
              @edit-message="handleEditMessage"
              @quote-action="emit('quoteAction', $event)"
              @load-older-messages="handleLoadOlderMessages"
              @edit-queued="handleEditQueued"
              @reorder-queue="handleReorderQueue"
              @steer-queued="emit('steerQueued', $event)"
            />
            </ErrorBoundary>
          </template>
        </div>
      </div>
      <ChatDock
        v-if="!(turns.length === 0 && !sessionLoading)"
        :ref="bindChatDock"
        :interrupt-armed="escInterruptArmed"
        :style="chatDockStyle"
        :session-plans="sessionPlans"
        :dock-panel="dockPanel"
        :bash-tasks="bashTasks"
        :subagent-tasks="subagentTasks"
        :bash-running="bashRunning"
        :subagent-running="subagentRunning"
        :todo-done-count="todoDoneCount"
        :has-dock-work="hasDockWork"
        :todos="todos"
        :pending-question="pendingQuestion"
        :question-busy-kind="questionBusyKind"
        :pending-approval="pendingApproval"
        :approval-busy="approvalBusy"
        :mobile="mobile"
        :before-submit="gateSubmit"
        :on-capture-screenshot="captureScreenshotAction"
        :screenshot-shortcut-keys="screenshotShortcutKeys"
        :screenshot-shortcut-unavailable="!!osGlobalFailures.captureScreenshot"
        :screenshot-shortcut-failure-reason="osGlobalFailures.captureScreenshot"
        :on-configure-screenshot-shortcut="configureScreenshotShortcut"
        @toggle-dock-panel="toggleDockPanel($event)"
        @close-dock-panel="closeDockPanel()"
        @answer="handleQuestionAnswer"
        @approval="handleApproval"
        @submit="handleComposerSubmit"
              @steer="handleComposerSteer"
        @steer-queued="emit('steerQueued', $event)"
        @command="handleComposerCommand"
        @interrupt="handleInterrupt"
        @focus-goal="focusGoal"
        @pick-model="emit('pickModel')"
        @login="emit('login')"
        @configure-model="emit('configureModel')"
      >
        <template #notice>
          <HostNotice class="dock-host-notice" :host-id="activeHostId" />
        </template>
      </ChatDock>
      <Transition name="pill">
        <button
          v-if="showPill && turns.length > 0"
          class="newmsg-pill"
          :style="{ bottom: `${dockHeight + 12}px` }"
          :aria-label="t('conversation.jumpToLatestAria')"
          @click="scrollToBottom(true)"
        >
          <Icon class="pill-chevron" name="arrow-down" size="sm" />
          {{ t('conversation.newMessages') }}
        </button>
      </Transition>
      </div>
      <SessionInfoPanel
        v-if="sessionInfoPanelVisible"
        :session-id="sessionInfoSessionId"
        :mode="sessionInfoMode"
        :tabs="panelTabs ?? []"
        :available="availableTabs ?? []"
        @open-pr="(url) => emit('openPr', url)"
        @open-diff="(root) => emit('openDiff', root)"
        @activate="(id) => emit('activateTab', id)"
        @open="(type) => emit('openTab', type)"
        @show-tabs="emit('showTabs')"
      />
    </div>

    <WorkspaceTrustDialog
      :open="showTrustDialog"
      :busy="trustBusy"
      @trust="onTrustWorkspace"
      @reject="onRejectTrust"
    />

    <!-- Transcript find bar (Cmd/Ctrl+F) — floats over the transcript's
         top-right corner. -->
    <TranscriptSearch
      v-if="transcriptSearchOpen"
      ref="transcriptSearchRef"
      :pane="panesRef"
      :mobile="mobile"
      :reveal="revealTranscriptRange"
      @close="closeTranscriptSearch"
    />
  </section>
</template>

<style scoped>
.con {
  --read-max: 760px;
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  position: relative;
  container-type: inline-size;
}

.empty-drag {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--panel-head-h, 48px);
}
.empty-drag.macos-desktop {
  -webkit-app-region: drag;
}

.empty-toggles {
  position: absolute;
  top: calc((var(--panel-head-h, 48px) - var(--icon-button-sm)) / 2);
  right: calc(var(--space-4) + var(--icon-button-sm) + var(--space-2));
  z-index: var(--z-sticky);
  -webkit-app-region: no-drag;
}
.app.right-panel-open .empty-toggles { right: var(--space-4); }

.panes {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-anchor: none;
  scrollbar-gutter: stable;
}

.panes::-webkit-scrollbar {
  width: var(--space-2);
}
.panes::-webkit-scrollbar-thumb {
  min-height: var(--space-6);
  border: var(--space-05) solid transparent;
  border-radius: var(--radius-full);
  background: transparent;
  background-clip: padding-box;
}
.panes:hover::-webkit-scrollbar-thumb,
.panes.scrolling::-webkit-scrollbar-thumb {
  background-color: var(--color-chat-scrollbar);
}
.panes::-webkit-scrollbar-thumb:hover,
.panes::-webkit-scrollbar-thumb:active {
  background-color: var(--color-chat-scrollbar-hover);
}

.panes.session-settling :deep(.chat > *:not(.chat-loading)) {
  visibility: hidden;
}

.chat-layout {
  display: flex;
  flex-direction: row;
  height: 100%;
  min-height: 0;
  position: relative;
}
.chat-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.chat-scroll {
  flex: 1;
  min-height: 0;
  position: relative;
}

.content-wrap {
  width: 100%;
  max-width: var(--read-max);
  min-height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.content-wrap.align-center { margin-left: auto; margin-right: auto; }
.content-wrap.align-left { margin-left: 0; margin-right: auto; }
.content-wrap.align-mobile { max-width: none; }
@media (max-width: 640px) {
  .con.mobile {
    min-width: 0;
    overflow: hidden;
  }
  .con.mobile .panes {
    scrollbar-gutter: auto;
    -webkit-overflow-scrolling: touch;
  }
  .content-wrap.align-mobile {
    width: 100%;
    min-width: 0;
  }
}

.empty-spacer { flex: 1; }
.empty-tail {
  min-height: 0;
  overflow-y: auto;
  padding-bottom: var(--space-4);
  box-sizing: border-box;
}

.empty-hint {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
  padding: 0 16px 16px;
  color: var(--color-text);
  font-family: var(--font-ui);
  user-select: none;
}
.empty-hint-title {
  font-size: calc(var(--ui-font-size) + 16px);
  font-optical-sizing: auto;
  font-weight: 600;
}
.empty-hint-title.is-starting {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  color: var(--dim);
  font-weight: 400;
}
.empty-logo {
  width: min(304px, 62vw);
}
.empty-composer { padding-top: 0; }
.empty-host-notice {
  flex: 0 1 auto;
  min-width: 0;
  margin: 0 var(--space-3) 4px var(--space-2);
}
.dock-host-notice {
  margin: 0 calc(var(--dock-inline-right, 16px) + var(--space-2)) var(--space-1) calc(var(--dock-inline-left, 16px) + var(--space-4));
}
.empty-composer :deep(.composer-card) { position: relative; z-index: var(--z-sticky); }
.empty-composer:not(.expanded) :deep(.ph) { min-height: 3lh; }
.ws-pill-row {
  box-sizing: border-box;
  display: flex;
  align-items: flex-end;
  height: 36px;
  padding: 0 var(--dock-inline-right, 16px) 0 calc(var(--dock-inline-left, 16px) + var(--space-4));
  font-family: var(--font-ui);
}
.ws-mascot {
  flex: none;
  width: 65px;
  height: 36px;
  margin-left: auto;
  margin-right: var(--space-8);
}
.ws-anchor {
  position: relative;
  display: flex;
  flex: 0 1 auto;
  min-width: 0;
}

.ws-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  height: 28px;
  margin-bottom: 4px;
  padding: 0 var(--space-2);
  background: var(--color-selected);
  -webkit-backdrop-filter: blur(30px);
  backdrop-filter: blur(30px);
  border: none;
  border-radius: 10px;
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--ui-font-size-sm);
  cursor: pointer;
  transition: color var(--duration-base) var(--ease-out);
}
.ws-chip:hover,
.ws-chip.open {
  color: var(--color-text-strong);
}
.ws-chip:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.ws-chip > .kw-icon { flex: none; }
.ws-chip-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--weight-option-label);
}
.ws-chip-chev {
  flex: none;
  transition: transform var(--duration-base) var(--ease-out);
}
.ws-chip.open .ws-chip-chev { transform: rotate(180deg); }

.ws-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-sticky);
}

.ws-panel {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  left: 0;
  top: calc(100% + var(--space-1));
  z-index: var(--z-dropdown);
  width: max-content;
  min-width: max(calc(var(--space-8) * 8), 100%);
  max-width: min(calc(var(--space-8) * 12), calc(100vw - var(--space-8)));
  max-height: calc(var(--space-8) * 10);
  overflow: hidden;
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  padding: var(--space-1);
  animation: ws-pop var(--duration-base) var(--ease-out);
}
.ws-panel.up {
  top: auto;
  bottom: calc(100% + var(--space-1));
  animation-name: ws-pop-up;
}
@keyframes ws-pop {
  from { opacity: 0; transform: translateY(calc(-1 * var(--space-1))) scale(0.99); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes ws-pop-up {
  from { opacity: 0; transform: translateY(var(--space-1)) scale(0.99); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.ws-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  margin: 0 var(--space-1);
  padding: var(--space-2) var(--space-1);
  border-bottom: var(--p-hairline) solid var(--color-line);
  color: var(--color-text-faint);
}

.ws-search:focus-within {
  border-bottom-color: var(--color-line-strong);
}

.ws-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
}

.ws-search-input::placeholder {
  color: var(--color-text-faint);
}

.ws-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.ws-empty {
  padding: var(--space-3) var(--space-2);
  color: var(--muted);
  font-size: var(--text-sm);
  text-align: center;
  user-select: none;
}

.ws-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-radius: var(--radius-dropdown-row);
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
  font-family: var(--font-ui);
}
.ws-row > .kw-icon,
.ws-row > .ws-icon { flex: none; color: var(--muted); }
.ws-row:hover { background: var(--color-hover); }
.ws-row.on { background: var(--color-selected); }
.ws-row:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.ws-row:disabled { cursor: default; }
.ws-row:disabled:hover { background: none; }
.ws-row:disabled .ws-name { color: var(--color-text-faint); }
.ws-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.ws-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-base);
  font-weight: var(--weight-option-label);
  color: var(--color-text);
  line-height: var(--leading-normal);
}
.ws-path {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  font-weight: var(--weight-option-label);
  color: var(--muted);
  line-height: var(--leading-normal);
}
.ws-check {
  flex: none;
  margin-left: var(--space-3);
  color: var(--color-text);
}

.ws-divider {
  height: 1px;
  margin: var(--space-1) var(--space-2);
  background: var(--line);
}

.ws-action {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-radius: var(--radius-dropdown-row);
  padding: var(--space-2);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--dim);
}
.ws-action > .kw-icon { flex: none; color: var(--muted); }
.ws-action span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-action:hover { background: var(--color-hover); color: var(--color-text); }
.ws-action:hover > .kw-icon { color: var(--dim); }
.ws-action:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }

.chat-scroll {
  display: flex;
  flex-direction: column;
}

.mobile .panes:has(> .chat-layout) {
  overflow: hidden;
  scrollbar-gutter: auto;
}

.newmsg-pill {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  border: var(--p-hairline) solid var(--line);
  background: var(--panel);
  color: var(--color-text);
  font-size: var(--text-xs);
  font-weight: var(--weight-ui-strong);
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  z-index: var(--z-sticky);
}
.pill-chevron {
  width: 12px;
  height: 12px;
}
.pill-enter-active,
.pill-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.pill-enter-from,
.pill-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

.con { background: var(--bg); }
.newmsg-pill { font-family: var(--sans); }
</style>
