<script setup lang="ts">
import { parseComposerSnapshot, type ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';
import { computed, inject, nextTick, onMounted, onUnmounted, provide, ref, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatTurn, ConversationStatus, OpenMediaRequest, QueuedPromptView, TaskItem, TurnAttachment, UIQuestion } from '../../types';
import type { QuestionResponse } from '../../api/types';
import { useSidebarTabs } from '@moonshot-ai/app-core';
import { ChatPane } from '@moonshot-ai/app-components';
import { HostNotice, resolveCompactPhase, WorkspaceIcon } from '@moonshot-ai/app-components/support';
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
import { toHtmlEl, useTranscriptScrollBinding } from '../../composables/useTranscriptScroll';
import { useTranscriptStabilityProbe } from '../../composables/useTranscriptStabilityProbe';
import WorkspaceHome from './WorkspaceHome.vue';
import { WorkspaceRecentSessions } from '@moonshot-ai/app-components';
import { ConversationToc, type ConversationTocItem } from '@moonshot-ai/app-components';
import TranscriptSearch from './TranscriptSearch.vue';
import { KimiCodeWordmark, KimiMascotPeek } from '@moonshot-ai/app-components';
import { Icon, Menu, MenuItem, MenuSearch, menuNavigationIndex, Spinner, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';
import { filterWorkspaces } from '@moonshot-ai/app-core/lib';
import { safeRemove, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { isMacosDesktop } from '@moonshot-ai/app-core/lib';
import { osGlobalFailures, resolvedBindingKeys } from '../../composables/useShortcuts';
import { OpenShortcutSettingsKey } from '../../lib/shortcutSettings';
import { closestRegion, isEditableTarget, isSelectAllKeyEvent, selectContentsOf } from '@moonshot-ai/app-core/lib';
import { isFindKeyEvent } from '@moonshot-ai/app-core/lib';
import { reviveQuoteBlockLinks } from '@moonshot-ai/app-composer/model';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import { FetchTurnFileChangesKey, ModelDisplayKey, ResolveAgentModelKey, ResolveAgentTaskIdKey, ResolveAgentTaskStateKey, ResolveDetachableTaskKey, SubagentEffortKey } from '@moonshot-ai/app-client/contracts';
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
import { turnHasOutput, turnTocTitle } from '@moonshot-ai/app-components';
import type {
  ComposerCommandPayload,
  ComposerSteerPayload,
  ComposerSubmitPayload,
  TurnFileChange,
} from '@moonshot-ai/app-components';
import type { SlashCommand } from '@moonshot-ai/app-core/lib';
import { feedbackTurnTarget } from '../../composables/useDesktopFeedback';
import TurnFeedbackActions from '../feedback/TurnFeedbackActions.vue';
import TurnFeedbackStatus from '../feedback/TurnFeedbackStatus.vue';

const { t } = useI18n();

const props = defineProps<{
  sessionId?: string;
  supportsReplyFeedback: boolean;
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

const feedbackCommands: readonly SlashCommand[] = [{ name: '/feedback', desc: 'feedback.send', noArgs: true }];

const emit = defineEmits<{
  submit: [payload: ComposerSubmitPayload];
  steer: [payload: ComposerSteerPayload];
  command: [payload: ComposerCommandPayload];
  interrupt: [];
  continue: [];
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
const screenshotProps = computed(() => ({
  onCaptureScreenshot: captureScreenshotAction,
  screenshotShortcutKeys: screenshotSupported ? resolvedBindingKeys('captureScreenshot') : [],
  screenshotShortcutUnavailable: !!osGlobalFailures.captureScreenshot,
  screenshotShortcutFailureReason: osGlobalFailures.captureScreenshot,
  onConfigureScreenshotShortcut: configureScreenshotShortcut,
}));

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
const compactPhase = computed(() => resolveCompactPhase(compaction.value, props.queued));
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
const wsPanelRef = ref<InstanceType<typeof Menu> | null>(null);
const wsChipRef = ref<HTMLButtonElement | null>(null);
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
const wsSearchRef = ref<InstanceType<typeof MenuSearch> | null>(null);
const filteredWorkspaces = computed(() =>
  filterWorkspaces(workspaces.value, workspaceQuery.value, hostsStore().searchTerms),
);

watch(wsPickOpen, async (open) => {
  if (!open) {
    workspaceQuery.value = '';
    return;
  }
  await nextTick();
  wsSearchRef.value?.focus();
});

function closeWsPick(restoreFocus = false): void {
  wsPickOpen.value = false;
  if (restoreFocus) wsChipRef.value?.focus();
}

function wsPanelItems(): HTMLElement[] {
  return [...(wsPanelRef.value?.el?.querySelectorAll<HTMLElement>('.ui-menu-item:not(:disabled)') ?? [])];
}

function focusWsItem(key: string, shiftKey = false): boolean {
  const items = wsPanelItems();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = menuNavigationIndex(key, shiftKey, current, items.length);
  if (next === null || next < 0) return false;
  items[next]?.focus();
  return true;
}

function onWsPanelKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeWsPick(true);
    return;
  }
  if (event.key === 'Tab') return;
  if (focusWsItem(event.key)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function toggleWsPick(event: MouseEvent): void {
  if (wsPickOpen.value) {
    closeWsPick();
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

function clearComposerAfterDispatch(expectedSnapshot?: ComposerDocumentSnapshot): void {
  (dockedComposerRef.value ?? emptyComposerRef.value)?.clearAfterDispatch(expectedSnapshot);
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

const { tocHidden: tocHiddenByWideTable, syncWideTable } = useWideTableToc();
const wideTableActive = computed(() => isWideTableLayoutActive(tocHiddenByWideTable.value, conversationHostWidth.value));
const sessionInfoPanelVisible = computed(() => sessionInfoVisible.value && !wideTableActive.value);

function syncWideTableToc(): void {
  syncWideTable(panesRef.value);
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

const transcriptSearchOpen = ref(false);
const historySelection = ref(false);
const historyState = new Map<string, unknown>();

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
const {
  panesRef,
  dockRef,
  bindChatPane,
  bindDock,
  following,
  showPill,
  panesScrolling,
  dockHeight,
  contentWrapStyle,
  chatDockStyle,
  activeTurnId,
  onPanesScroll,
  onPanesWheel,
  onPanesPointerDown,
  onPanesTouchStart,
  onPanesTouchMove,
  onTranscriptKeyDown,
  scrollToBottom,
  scrollToTurn,
  revealTranscriptRange,
  followAfterUserAction,
  handleLoadOlderMessages,
} = useTranscriptScrollBinding({
  sessionId: () => props.sessionId,
  mobile: () => props.mobile,
  turns,
  hasMoreMessages,
  loadingMore,
  conversationTocItems,
  loadOlderMessages: (sessionId) => client.loadOlderMessages(sessionId),
  syncWideTableToc,
  keyScrollBlocked: (event) => isComposingKeyEvent(event) || anyOverlayOpen.value || composerPopupOpen(),
});
useTranscriptStabilityProbe(panesRef);
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
  clearAfterDispatch: (expectedSnapshot?: ComposerDocumentSnapshot) => void;
  anyPopupOpen?: boolean;
  isEmpty?: () => boolean;
};
type RefArg = Element | (ComponentPublicInstance & Partial<ComposerHandle>) | null;

function bindChatDock(el: RefArg): void {
  const node = toHtmlEl(el);
  if (node === dockRef.value) return;
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
      clearAfterDispatch:
        'clearAfterDispatch' in el && typeof el.clearAfterDispatch === 'function'
          ? el.clearAfterDispatch.bind(el)
          : () => {},
      get anyPopupOpen(): boolean {
        return 'anyPopupOpen' in el && el.anyPopupOpen === true;
      },
      isEmpty:
        'isEmpty' in el && typeof el.isEmpty === 'function' ? el.isEmpty.bind(el) : undefined,
    };
  } else {
    dockedComposerRef.value = null;
  }
  bindDock(node);
}

function handleComposerSubmit(payload: ComposerSubmitPayload): void {
  followAfterUserAction();
  emit('submit', payload);
}

function handleComposerSteer(payload: ComposerSteerPayload): void {
  followAfterUserAction();
  emit('steer', payload);
}

function handleComposerCommand(payload: ComposerCommandPayload): void {
  if (payload.delivery !== undefined || payload.cmd === '/compact' || payload.cmd.startsWith('/compact ')) {
    followAfterUserAction();
  }
  emit('command', payload);
}

function handleEditMessage(payload: {
  text: string;
  attachments?: TurnAttachment[];
  snapshot?: ComposerDocumentSnapshot;
  turnId: string;
}): void {
  followAfterUserAction();
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

const interruptedTurnId = computed<string | null>(() => {
  if (turnEnd.value?.outcome !== 'interrupted' || props.working || turnActive.value) return null;
  const last = turns.value[turns.value.length - 1];
  return last?.role === 'assistant' && turnHasOutput(last) ? last.id : null;
});

const turnFailed = computed<boolean>(
  () =>
    turnEnd.value?.outcome === 'failed' &&
    turnEnd.value.end_reason !== 'blocked' &&
    !props.working &&
    !turnActive.value &&
    turns.value.length > 0,
);

function handleResumeTurn(): void {
  if (!gateSubmit()) return;
  followAfterUserAction();
  emit('continue');
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
  onTranscriptKeyDown(event);
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

onMounted(() => {
  document.addEventListener('selectionchange', onTranscriptSelectionChange);
  nextTick(() => {
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('pointerdown', onDocumentPointerDown, true);
      document.addEventListener('compositionstart', handleCompositionStart);
      document.addEventListener('compositionend', handleCompositionEnd);
    }
  });
});

onUnmounted(() => {
  document.removeEventListener('selectionchange', onTranscriptSelectionChange);
  if (typeof document !== 'undefined') {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('compositionstart', handleCompositionStart);
    document.removeEventListener('compositionend', handleCompositionEnd);
  }
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

defineExpose({ loadComposerForEdit, insertComposerQuote, insertComposerPathMention, insertScreenshotAnnotation, addComposerFiles, hasInsertableComposer, isComposerEmpty, clearComposerAfterDispatch, focusComposer, notifyUndone, selectAllRegion, focusGoal, closeDockPanel, composerPopupOpen });
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
                    ref="wsChipRef"
                    type="button"
                    class="ws-chip"
                    :class="{ open: wsPickOpen }"
                    aria-haspopup="dialog"
                    :aria-expanded="wsPickOpen"
                    @click.stop="toggleWsPick"
                  >
                    <WorkspaceIcon :host-id="activeHostId" status="all" />
                    <span class="ws-chip-name">{{ activeWorkspaceLabel }}</span>
                    <Icon class="ws-chip-chev" name="chevron-down" size="sm" />
                  </button>
                </Tooltip>
                <Menu
                  v-if="wsPickOpen"
                  ref="wsPanelRef"
                  class="ws-panel"
                  :class="{ up: wsPickUp }"
                  :style="wsPickMaxHeight ? { maxHeight: wsPickMaxHeight } : undefined"
                  role="dialog"
                  :aria-label="t('conversation.switchWorkspace')"
                  @keydown="onWsPanelKeydown"
                >
                  <MenuSearch
                    ref="wsSearchRef"
                    v-model="workspaceQuery"
                    class="ws-search"
                    divider
                    :placeholder="t('workspace.projectSearchPlaceholder')"
                    @navigate="focusWsItem"
                    @escape="closeWsPick(true)"
                    @click.stop
                    @keydown.stop
                  />
                  <div class="ws-list" role="listbox" :aria-label="t('conversation.switchWorkspace')">
                    <MenuItem
                      v-for="w in filteredWorkspaces"
                      :key="w.id"
                      class="ws-row"
                      role="option"
                      :selected="w.id === activeWorkspaceId"
                      :description="hostsStore().workspacePathLabel(w, t)"
                      :disabled="hostsStore().blocked(w.hostId)"
                      @click.stop="pickWorkspace(w.id)"
                    >
                      <template #icon><WorkspaceIcon :host-id="w.hostId" status="all" /></template>
                      <span class="ws-name">{{ w.name }}</span>
                    </MenuItem>
                    <div v-if="filteredWorkspaces.length === 0" class="ws-empty">
                      {{ t('workspace.projectSearchNoResults') }}
                    </div>
                  </div>
                  <MenuItem separator />
                  <MenuItem role="button" @click.stop="closeWsPick(); emit('addWorkspace')">
                    <Icon name="folder-plus" />
                    <span>{{ t('conversation.addWorkspace') }}</span>
                  </MenuItem>
                </Menu>
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
              :defer-submit-reset="true"
              :extra-builtin-commands="feedbackCommands"
              v-bind="screenshotProps"
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
            <div v-if="wsPickOpen" class="ws-backdrop" @click="closeWsPick()" />
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
              :render-all-history="transcriptSearchOpen || historySelection"
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
            >
              <template v-if="supportsReplyFeedback" #assistant-reply-actions="{ turn }">
                <TurnFeedbackActions :target="feedbackTurnTarget(sessionId, turn)" />
              </template>
              <template v-if="supportsReplyFeedback" #assistant-reply-status="{ turn }">
                <TurnFeedbackStatus :target="feedbackTurnTarget(sessionId, turn)" />
              </template>
            </ChatPane>
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
        :defer-submit-reset="true"
        :extra-builtin-commands="feedbackCommands"
        v-bind="screenshotProps"
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
        :ctx-used="status.ctxUsed"
        :ctx-max="status.ctxMax"
        :model-id="status.modelId"
        :running="client.activity.value !== 'idle'"
        :has-messages="turns.length > 0 || Boolean(working)"
        :compact-phase="compactPhase"
        :tabs="panelTabs ?? []"
        :available="availableTabs ?? []"
        @open-pr="(url) => emit('openPr', url)"
        @open-diff="(root) => emit('openDiff', root)"
        @activate="(id) => emit('activateTab', id)"
        @open="(type) => emit('openTab', type)"
        @show-tabs="emit('showTabs')"
        @compact="handleComposerCommand({ cmd: '/compact', attachments: [], preserveDraft: true })"
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
  display: flex;
  flex-direction: column;
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
  left: 0;
  top: calc(100% + var(--space-1));
  z-index: var(--z-dropdown);
  width: max-content;
  max-width: min(calc(var(--space-8) * 12), calc(100vw - var(--space-8)));
  max-height: calc(var(--space-8) * 10);
  overflow: hidden;
  animation: ws-pop var(--duration-base) var(--ease-out);
}
.ws-panel.ui-menu { min-width: max(calc(var(--space-8) * 8), 100%); }
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
