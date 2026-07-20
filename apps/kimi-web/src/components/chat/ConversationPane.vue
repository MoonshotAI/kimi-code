<!-- apps/kimi-web/src/components/chat/ConversationPane.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ActivationBadges, ApprovalBlock, ChatTurn, ConversationStatus, FilePreviewRequest, PermissionMode, QueuedPromptView, TaskItem, TodoView, ToolMedia, TurnAttachment, UIQuestion, WorkspaceView } from '../../types';
import type { AppGoal, AppModel, AppSkill, QuestionResponse, ThinkingLevel } from '../../api/types';
import type { FileItem } from './MentionMenu.vue';
import type { PromptAttachment } from '../../composables/useKimiWebClient';
import ChatPane from './ChatPane.vue';
import ChatHeader from './ChatHeader.vue';
import Composer from './Composer.vue';
import ChatDock from './ChatDock.vue';
import ConversationToc, { type ConversationTocItem } from './ConversationToc.vue';
import Icon from '../ui/Icon.vue';
import Spinner from '../ui/Spinner.vue';
import Tooltip from '../ui/Tooltip.vue';
import { getVisibleWorkspaces } from '../../lib/workspacePicker';
import { safeRemove, STORAGE_KEYS } from '../../lib/storage';

const { t } = useI18n();

const props = defineProps<{
  turns: ChatTurn[];
  sessionId?: string;
  approvals?: { approvalId: string; block: ApprovalBlock; agentName?: string }[];
  gitInfo?: { branch: string; ahead: number; behind: number } | null;
  tasks: TaskItem[];
  /** Model-maintained todo list (TodoList tool) — shown as a floating card. */
  todos?: TodoView[];
  goal?: AppGoal | null;
  activationBadges?: ActivationBadges;
  status: ConversationStatus;
  thinking?: ThinkingLevel;
  planMode?: boolean;
  swarmMode?: boolean;
  goalMode?: boolean;
  questions?: UIQuestion[];
  /** Question ids with an in-flight respond/dismiss (drives the card loading
   *  state). Keyed by questionId with the action kind. */
  pendingQuestionActions?: Record<string, 'answer' | 'dismiss'>;
  /** Approval ids with an in-flight respond (drives the card loading state). */
  pendingApprovalActions?: Record<string, true>;
  /** Session busy (any agent, incl. background work) — Stop/Escape affordances. */
  running?: boolean;
  /** MAIN agent turn in flight — the conversation's streaming state (streaming
   *  reveal, turn-end scroll settle). Background-only work does NOT set this. */
  turnActive?: boolean;
  queued?: QueuedPromptView[];
  searchFiles?: (q: string) => Promise<FileItem[]>;
  uploadImage?: (file: Blob, name?: string) => Promise<{ fileId: string; name: string; mediaType: string } | null>;
  /** Git changed files (only used for the header diff counter dot). */
  changes?: { path: string; status: string }[];
  /** Cache-buster that remounts the chat pane when the active session changes. */
  fileReloadKey?: string | number;
  /** The main conversation has an unfinished prompt (submitted or a main turn
   *  in flight) — the working moon. */
  working?: boolean;
  /** True while the empty-composer first prompt is being created + submitted.
   *  Drives the empty-session "starting conversation…" loading state. */
  starting?: boolean;
  fastMoon?: boolean;
  /** Mobile shell: compact chrome. */
  mobile?: boolean;
  /** True while switching sessions and the turns array is not yet loaded. */
  sessionLoading?: boolean;
  /** Live compaction state of the active session (non-null while running). */
  compaction?: { status: 'running' } | null;
  /** Whether there are older messages available to load when scrolling up. */
  hasMoreMessages?: boolean;
  /** True while older messages are being fetched (scroll-up lazy load). */
  loadingMore?: boolean;
  /** True when the last older-message fetch failed; blocks sentinel auto-retry. */
  loadingMoreError?: boolean;
  /** Callback to fetch the next older page of messages. */
  loadOlderMessages?: (sessionId: string) => Promise<void>;
  /** Available models for the quick-switch dropdown in the composer toolbar. */
  models?: AppModel[];
  /** Starred model ids shown at the top of the composer's quick-switch dropdown. */
  starredIds?: string[];
  /** Session skills shown in the composer `/` menu. */
  skills?: AppSkill[];
  /** Workspace name shown in the empty-session hint above the centred composer. */
  workspaceName?: string;
  /** Absolute workspace root path. */
  workspaceRoot?: string;
  /** Git diff line stats for the header diff counter (mirrors kimi-cli/web). */
  gitDiffStats?: { totalAdditions: number; totalDeletions: number } | null;
  /** Workspaces for the empty-composer picker (start a conversation elsewhere). */
  workspaces?: WorkspaceView[];
  /** Active workspace id, to highlight the current entry in the picker. */
  activeWorkspaceId?: string | null;
  /** Active session title, shown in the chat header. */
  sessionTitle?: string;
  /** GitHub PR for the current branch, when known (shown in the chat header). */
  pr?: { number: number; state: string; url: string } | null;
  /** Conversation outline: proportional bubbles, viewport indicator, hover tooltip. */
  conversationToc?: boolean;
}>();

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: PromptAttachment[] }];
  steer: [payload: { text: string; attachments: PromptAttachment[] }];
  approval: [approvalId: string, response: { decision: 'approved' | 'rejected' | 'cancelled'; scope?: 'session'; feedback?: string }];
  cancelTask: [taskId: string];
  answer: [questionId: string, response: QuestionResponse];
  dismiss: [questionId: string];
  command: [cmd: string];
  interrupt: [];
  unqueue: [index: number];
  editQueued: [index: number];
  reorderQueue: [payload: { from: number; to: number }];
  setPermission: [mode: PermissionMode];
  setThinking: [level: ThinkingLevel];
  togglePlan: [];
  toggleSwarm: [];
  toggleGoal: [];
  createGoal: [objective: string];
  controlGoal: [action: 'pause' | 'resume' | 'cancel'];
  compact: [];
  pickModel: [];
  selectModel: [modelId: string];
  openFile: [target: FilePreviewRequest];
  openMedia: [media: ToolMedia];
  openThinking: [target: { turnId: string; blockIndex: number }];
  openCompaction: [target: { turnId: string }];
  openAgent: [toolCallId: string];
  openToolDiff: [id: string];
  /** Chat header / files pane: focus the diff detail layer and refresh git status. */
  openChanges: [];
  refreshGitStatus: [];
  /** Edit + resend the last user message (App undoes, then refills composer). */
  editMessage: [payload: { text: string; attachments?: TurnAttachment[] }];
  /** Empty-composer workspace picker: start a new conversation elsewhere. */
  selectWorkspace: [workspaceId: string];
  /** Empty-composer workspace picker: create a new workspace. */
  addWorkspace: [];
  /** Chat header: open the GitHub PR in a new tab. */
  openPr: [url: string];
  /** Chat header / session row: rename current session. */
  renameSession: [id: string, title: string];
  /** Chat header / session row: fork current session. */
  forkSession: [id: string];
  /** Chat header / session row: archive current session. */
  archiveSession: [id: string];
  /** Chat header: export current session. */
  exportSession: [id: string];
}>();

// Empty-composer workspace picker.
const wsPickOpen = ref(false);
const wsPickExpanded = ref(false);

const activeWorkspaceLabel = computed(() => {
  const w = props.workspaces?.find((ws) => ws.id === props.activeWorkspaceId);
  return w?.name ?? props.workspaceName ?? '';
});

const hasWorkspaces = computed(() => (props.workspaces?.length ?? 0) > 0);

const visibleWorkspaces = computed(() =>
  getVisibleWorkspaces(props.workspaces ?? [], props.activeWorkspaceId, wsPickExpanded.value),
);

const hiddenWorkspaceCount = computed(
  () => (props.workspaces?.length ?? 0) - visibleWorkspaces.value.length,
);

// Collapse the expanded list when the dropdown closes so it doesn't stay open
// the next time the user opens the menu.
watch(wsPickOpen, (open) => {
  if (!open) wsPickExpanded.value = false;
});

function pickWorkspace(id: string): void {
  wsPickOpen.value = false;
  if (id !== props.activeWorkspaceId) emit('selectWorkspace', id);
}

// The align toggle was removed with its UI (6e50cb7) — reading layout is
// always centered now. Drop the old persisted preference so users who once
// picked 'left' aren't frozen on it with no way back.
safeRemove(STORAGE_KEYS.contentAlign);

const chatPaneRef = ref<InstanceType<typeof ChatPane> | null>(null);
const emptyComposerRef = ref<ComposerHandle | null>(null);
const dockedComposerRef = ref<ComposerHandle | null>(null);
const copyConversationCopied = ref(false);
const goalExpandSignal = ref(0);
let copyConversationCopiedTimer: ReturnType<typeof setTimeout> | null = null;

/** Load text (and any attachments) into whichever composer is currently mounted
    (docked vs the empty-session composer). Used by App for "edit & resend the
    last message", and by the queue when a pending prompt is loaded for edit.
    Returns false when no composer is actually able to receive the content (e.g.
    the dock is showing a pending question/approval and the composer is hidden),
    so the caller can avoid dropping the prompt. */
function loadComposerForEdit(
  value: string,
  attachments?: TurnAttachment[],
): boolean {
  const composer = dockedComposerRef.value ?? emptyComposerRef.value;
  if (!composer) return false;
  // loadForEdit returns false when the dock's nested Composer is hidden; the
  // empty composer's loadForEdit returns void (treat as success).
  const ok = composer.loadForEdit(value);
  if (ok === false) return false;
  composer.loadAttachmentsForEdit(attachments ?? []);
  return true;
}

function handleCopyConversationCopied(): void {
  copyConversationCopied.value = true;
  if (copyConversationCopiedTimer !== null) clearTimeout(copyConversationCopiedTimer);
  copyConversationCopiedTimer = setTimeout(() => {
    copyConversationCopiedTimer = null;
    copyConversationCopied.value = false;
  }, 2000);
}

function focusGoal(): void {
  goalExpandSignal.value++;
}

const bashTasks = computed(() => props.tasks.filter((t) => t.kind !== 'subagent'));
// The dock lists only BACKGROUND subagents. Foreground subagents render inline
// in the message flow as the `Agent` tool card, so showing them here too would
// duplicate them (and foreground ones can't be cancelled from the dock anyway).
const subagentTasks = computed(() =>
  props.tasks.filter((t) => t.kind === 'subagent' && t.runInBackground),
);
const bashRunning = computed(() => bashTasks.value.filter((t) => t.state === 'run').length);
const subagentRunning = computed(() => subagentTasks.value.filter((t) => t.state === 'run').length);

// Let AgentTool cards know whether their spawning tool-call has a matching live
// or background subagent task, so the "Open detail" button can be hidden when
// the task is gone (e.g. a completed foreground subagent after a page refresh).
function resolveAgentTaskId(toolCallId: string): string | undefined {
  const tasks = props.tasks;
  const task =
    tasks.find((tk) => tk.id === toolCallId) ?? tasks.find((tk) => tk.parentToolCallId === toolCallId);
  if (task) return task.id;
  // A subagent task synthesized from a text delta (client subscribed after the
  // spawn, so the lifecycle parentToolCallId was missed) has no parentToolCallId.
  // When exactly one such unmapped subagent task exists, attribute it to this
  // Agent tool call so the Open-detail button stays reachable.
  const unmapped = tasks.filter((tk) => tk.kind === 'subagent' && !tk.parentToolCallId);
  if (unmapped.length === 1) return unmapped[0]!.id;
  return undefined;
}
provide('resolveAgentTaskId', resolveAgentTaskId);
provide('pinScroll', pinScrollFor);
const todoDoneCount = computed(() => (props.todos ?? []).filter((td) => td.status === 'done').length);
const hasDockWork = computed(() =>
  bashTasks.value.length > 0 ||
  subagentTasks.value.length > 0 ||
  (props.todos?.length ?? 0) > 0 ||
  (props.queued?.length ?? 0) > 0,
);
const dockPanel = ref<'bash' | 'subagent' | 'todos' | null>(null);
const changesCount = computed(() => (props.gitInfo ? props.changes?.length ?? 0 : 0));

function toggleDockPanel(panel: 'bash' | 'subagent' | 'todos'): void {
  dockPanel.value = dockPanel.value === panel ? null : panel;
}

function closeDockPanel(): void {
  dockPanel.value = null;
}

watch(hasDockWork, (hasWork) => {
  if (!hasWork) closeDockPanel();
});

function tocTitle(turn: ChatTurn): string {
  if (turn.role === 'compaction') return t('conversation.compactedPlain');
  if (turn.role === 'user') {
    if (turn.skillActivation) return `/${turn.skillActivation.name}`;
    if (turn.pluginCommand) return `/${turn.pluginCommand.pluginId}:${turn.pluginCommand.commandName}`;
    const text = turn.text.trim().replaceAll(/\s+/g, ' ');
    return text.length > 0 ? text : 'user';
  }
  const text = (turn.text || turn.thinking || '').trim().replaceAll(/\s+/g, ' ');
  if (text.length > 0) return text;
  if ((turn.tools?.length ?? 0) > 0) return `${turn.tools!.length} tools`;
  return 'kimi';
}

// The TOC is keyed by user query: one entry per user turn, not per turn/block.
const conversationTocItems = computed<ConversationTocItem[]>(() =>
  props.turns
    .filter((turn) => turn.role === 'user')
    .map((turn, index) => ({
      id: turn.id,
      role: turn.role,
      no: index + 1,
      title: tocTitle(turn),
    })),
);

const activeTurnId = ref<string | null>(null);

function updateActiveTocQuery(): void {
  const pane = panesRef.value;
  if (!pane) return;
  const anchors = pane.querySelectorAll<HTMLElement>('.turn-anchor[data-turn-id]');
  if (anchors.length === 0) return;
  const items = conversationTocItems.value;
  if (items.length === 0) return;
  const userIds = new Set(items.map((item) => item.id));

  // When pinned to the bottom (auto-follow / short content), the latest query is
  // the active one even if its message sits below the pane's vertical middle —
  // otherwise the highlight would lag one query behind at the bottom.
  if (distanceFromBottom() <= BOTTOM_THRESHOLD) {
    activeTurnId.value = items[items.length - 1]!.id;
    return;
  }

  const paneRect = pane.getBoundingClientRect();
  const paneMiddle = paneRect.height / 2;
  // Otherwise the active highlight tracks the query that owns the current
  // viewport: the last user-turn anchor at or above the middle.
  let bestId: string | null = null;
  anchors.forEach((el) => {
    const id = el.dataset.turnId;
    if (!id || !userIds.has(id)) return;
    const top = el.getBoundingClientRect().top - paneRect.top;
    if (top <= paneMiddle) bestId = id;
  });
  activeTurnId.value = bestId ?? items[0]!.id;
}

// --- TOC occlusion by wide tables -------------------------------------------
// Wide markdown tables (up to --p-table-max) can extend past the TOC rail,
// which stays anchored to the reading-column edge. While a table actually
// covers the rail we hide the TOC temporarily so the table stays fully
// interactive (clicks, text selection, horizontal scroll). The user's TOC
// setting is untouched and the rail returns as soon as the table scrolls away.
const tocOccludedByTable = ref(false);
let tocHitTestRaf = 0;

function scheduleTocTableHitTest(): void {
  if (tocHitTestRaf) return;
  tocHitTestRaf = raf(() => {
    tocHitTestRaf = 0;
    updateTocTableOcclusion();
  });
}

function updateTocTableOcclusion(): void {
  const pane = panesRef.value;
  const toc =
    !props.mobile && props.conversationToc && pane
      ? pane.closest('.con')?.querySelector<HTMLElement>('.conversation-toc')
      : null;
  // The hit x is the centre of the fixed rail bar: `.toc-bar` keeps a stable x
  // even when hover expands the labels rightward, so hovering the TOC itself
  // never flips the state (the nav centre would).
  const bar = toc?.querySelector<HTMLElement>('.toc-bar');
  let covered = false;
  if (pane && toc && bar) {
    const barRect = bar.getBoundingClientRect();
    const tocRect = toc.getBoundingClientRect();
    const railX = barRect.left + barRect.width / 2;
    // Plain geometric overlap: the rail paints above the content, so any table
    // wrapper that covers the bar's x AND overlaps the rail vertically would
    // have its pointer events intercepted by the rail — hide the TOC until the
    // table scrolls away. Rect overlap is exact (no sampling gap) and ignores
    // paint-order quirks. Only wrappers inside THIS pane count; other panes
    // (side chat, preview) are outside `pane`.
    covered = Array.from(
      pane.querySelectorAll<HTMLElement>('.table-node-wrapper'),
    ).some((wrapper) => {
      const rect = wrapper.getBoundingClientRect();
      return (
        rect.left <= railX &&
        railX <= rect.right &&
        rect.top < tocRect.bottom &&
        rect.bottom > tocRect.top
      );
    });
  }
  if (tocOccludedByTable.value !== covered) {
    tocOccludedByTable.value = covered;
  }
}

// The first pending question (if any)
const pendingQuestion = computed<UIQuestion | undefined>(() =>
  props.questions && props.questions.length > 0 ? props.questions[0] : undefined,
);

// Action kind currently in flight for the visible question card, if any. Drives
// the submit/dismiss loading state and disables the buttons while the daemon
// processes the response.
const questionBusyKind = computed<'answer' | 'dismiss' | undefined>(() => {
  const q = pendingQuestion.value;
  if (!q) return undefined;
  return props.pendingQuestionActions?.[q.questionId];
});

// The first pending approval (if any). Rendered in the SAME bottom-dock slot as
// the question (replacing the composer) so both "agent is blocked on you"
// prompts live in one consistent place instead of approvals scrolling away at
// the end of the transcript while questions stay pinned.
const pendingApproval = computed(() =>
  props.approvals && props.approvals.length > 0 ? props.approvals[0] : undefined,
);

// True while the visible approval card has a respond in flight. Drives the
// action buttons' loading/disabled state and blocks duplicate decisions.
const approvalBusy = computed<boolean>(() => {
  const a = pendingApproval.value;
  if (!a) return false;
  return !!props.pendingApprovalActions?.[a.approvalId];
});

// ---------------------------------------------------------------------------
// Auto-scroll: "following" state machine + "new messages" pill
// ---------------------------------------------------------------------------

const panesRef = ref<HTMLElement | null>(null);
const dockRef = ref<HTMLElement | null>(null);
const panesScrollbarWidth = ref(0);
const dockHeight = ref(0);
const chatDockStyle = computed(() => ({
  '--panes-scrollbar-width': `${panesScrollbarWidth.value}px`,
}));
type ComposerHandle = {
  loadForEdit: (value: string) => boolean | void;
  loadAttachmentsForEdit: (atts: { fileId?: string; kind: 'image' | 'video' | 'file'; url: string; name?: string }[]) => void;
  focus: () => void;
};
type RefArg = Element | (ComponentPublicInstance & Partial<ComposerHandle>) | null;

function toHtmlEl(el: RefArg): HTMLElement | null {
  if (el instanceof HTMLElement) return el;
  if (el && '$el' in el && el.$el instanceof HTMLElement) return el.$el;
  return null;
}

function updatePanesScrollbarWidth(): void {
  const el = panesRef.value;
  panesScrollbarWidth.value = el ? Math.max(0, el.offsetWidth - el.clientWidth) : 0;
  dockHeight.value = dockRef.value?.offsetHeight ?? 0;
}

function bindChatPane(el: RefArg): void {
  const node = toHtmlEl(el);
  panesRef.value = node;
  if (node) rebindScrollObservers();
}

function bindChatDock(el: RefArg): void {
  const node = toHtmlEl(el);
  dockRef.value = node ?? null;
  if (
    el &&
    'loadForEdit' in el && typeof el.loadForEdit === 'function' &&
    'focus' in el && typeof el.focus === 'function'
  ) {
    dockedComposerRef.value = {
      loadForEdit: el.loadForEdit.bind(el),
      loadAttachmentsForEdit:
        'loadAttachmentsForEdit' in el && typeof el.loadAttachmentsForEdit === 'function'
          ? el.loadAttachmentsForEdit.bind(el)
          : () => {},
      focus: el.focus.bind(el),
    };
  } else {
    dockedComposerRef.value = null;
  }
  ensureDockObserved();
}

// Silence noUnusedLocals: both are used as :ref callbacks in the template.
void bindChatPane;
void bindChatDock;

const following = ref(true);
const showPill = ref(false);

/** Within this many pixels from the bottom counts as "at the bottom" —
    scrolling DOWN into this zone re-enables the follow. */
const BOTTOM_THRESHOLD = 80;
const USER_ACTION_FOLLOW_LOCK_MS = 1000;

function distanceFromBottom(): number {
  const el = panesRef.value;
  if (!el) return 0;
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

let lastScrollTop = 0;
let userActionFollowUntil = 0;
let lastSmoothScroll = 0;
// While a smooth scroll is in flight, instant `scrollToBottom(false)` calls
// (e.g. from the streaming follow) are skipped so they don't cancel the
// animation — see scrollToBottom().
let smoothScrollUntil = 0;
const SMOOTH_SCROLL_GUARD_MS = 420;
let stableFollowRaf = 0;
let stableFollowToken = 0;

function hasUserActionFollowLock(): boolean {
  return Date.now() < userActionFollowUntil;
}

function onPanesScroll(): void {
  scheduleTocTableHitTest();
  const el = panesRef.value;
  if (!el) return;
  const top = el.scrollTop;

  if (isPinned()) {
    lastScrollTop = top;
    return;
  }

  if (performance.now() - lastSmoothScroll < 100) {
    lastScrollTop = top;
    return;
  }

  const dist = distanceFromBottom();
  if (hasUserActionFollowLock()) {
    following.value = true;
    showPill.value = false;
    lastScrollTop = top;
    return;
  }
  if (top < lastScrollTop - 1 && dist > 1) {
    following.value = false;
    showPill.value = true;
  } else if (dist <= BOTTOM_THRESHOLD && top > lastScrollTop + 1) {
    following.value = true;
    showPill.value = false;
  }
  lastScrollTop = top;
  updateActiveTocQuery();
}

function scrollToBottom(smooth = false): void {
  const el = panesRef.value;
  following.value = true;
  showPill.value = false;
  if (!el) return;
  // A smooth scroll (e.g. right after sending a message) needs time to play;
  // skip instant jumps during the guard window so the streaming follow doesn't
  // immediately snap to the bottom and cancel the animation.
  if (!smooth && performance.now() < smoothScrollUntil) return;
  if (smooth && typeof el.scrollTo === 'function') {
    lastSmoothScroll = performance.now();
    smoothScrollUntil = performance.now() + SMOOTH_SCROLL_GUARD_MS;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  } else {
    el.scrollTop = el.scrollHeight;
  }
  lastScrollTop = el.scrollTop;
}

type ScrollAnchor = { kind: 'turn' | 'tool'; id: string; top: number };

function scrollAnchorTop(container: HTMLElement, node: HTMLElement): number {
  // Tool calls inside a collapsed group still exist under an inert, clipped
  // body. Anchor them to the visible group row so hidden content cannot create
  // a fake layout delta while the stable tool id remains usable.
  const inert = node.closest<HTMLElement>('[inert]');
  const positionNode = inert?.closest<HTMLElement>('.tool-group') ?? node;
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
  // The first id can be rebuilt when a page boundary splits an assistant turn;
  // a nearby turn or tool call retains a stable fallback.
  return anchors.slice(start, start + 2).flatMap((anchor) => {
    const toolId = anchor.node.dataset.scrollAnchorId;
    const id = toolId ?? anchor.node.dataset.turnId;
    return id ? [{ kind: toolId ? 'tool' : 'turn', id, top: anchor.top }] : [];
  });
}

type HistoryScrollSnapshot = {
  anchors: ScrollAnchor[];
  oldHeight: number;
};

const pendingHistoryRestoreBySession = new Map<string, HistoryScrollSnapshot>();

function historyScrollDelta(container: HTMLElement, snapshot: HistoryScrollSnapshot): number {
  for (const anchor of snapshot.anchors) {
    const attr = anchor.kind === 'tool' ? 'data-scroll-anchor-id' : 'data-turn-id';
    const newAnchor = container.querySelector<HTMLElement>(
      `[${attr}="${attrEscape(anchor.id)}"]`,
    );
    if (newAnchor) return scrollAnchorTop(container, newAnchor) - anchor.top;
  }
  // If the page boundary split an assistant/tool turn, messagesToTurns may
  // rebuild that turn with a new id. Fall back to the overall height delta.
  return container.scrollHeight - snapshot.oldHeight;
}

function restoreHistoryScroll(
  container: HTMLElement,
  snapshot: HistoryScrollSnapshot,
  currentTop = container.scrollTop,
): number {
  container.scrollTop = currentTop + historyScrollDelta(container, snapshot);
  lastScrollTop = container.scrollTop;
  return container.scrollTop;
}

async function handleLoadOlderMessages(): Promise<void> {
  if (
    !props.sessionId ||
    !props.loadOlderMessages ||
    props.loadingMore ||
    historyLoadInProgress.value ||
    !props.hasMoreMessages
  ) {
    return;
  }
  const requestedSessionId = props.sessionId;
  const el = panesRef.value;
  const oldTop = el?.scrollTop ?? 0;
  const snapshot: HistoryScrollSnapshot = {
    anchors: el ? findTopAnchors(el, oldTop) : [],
    oldHeight: el?.scrollHeight ?? 0,
  };

  setHistoryLoadInProgress(requestedSessionId, true);
  cancelScheduledFollow();
  try {
    // Flush the class that disables native scroll anchoring before Vue prepends
    // history. The explicit delta restoration below owns this one mutation;
    // native anchoring resumes afterwards for late Markdown/media layout shifts.
    await nextTick();
    await props.loadOlderMessages(requestedSessionId);
    await nextTick();

    // If the user switched sessions while the request was in flight, do not
    // restore the newly selected pane. Save the original anchor so the deferred
    // per-session scroll state can be adjusted when this session mounts again.
    if (props.sessionId !== requestedSessionId) {
      pendingHistoryRestoreBySession.set(requestedSessionId, snapshot);
      return;
    }

    const el2 = panesRef.value;
    if (!el2) return;

    // Restore scroll position using a stable anchor near the old viewport top.
    // This isolates height inserted above the anchor and ignores any new bottom
    // content (e.g. streaming assistant turns) that arrived during the request.
    // Apply the delta to the CURRENT scrollTop, not the pre-fetch oldTop: the
    // user may have kept scrolling (e.g. trackpad momentum) while the request
    // was in flight, and snapping back to oldTop would yank the viewport down.
    restoreHistoryScroll(el2, snapshot);
    pendingHistoryRestoreBySession.delete(requestedSessionId);
  } finally {
    setHistoryLoadInProgress(requestedSessionId, false);
  }
}

function attrEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replaceAll(/["\\]/g, '\\$&');
}

function scrollToTurn(turnId: string): void {
  const el = panesRef.value;
  if (!el) return;
  const target = el.querySelector<HTMLElement>(`.turn-anchor[data-turn-id="${attrEscape(turnId)}"]`);
  if (!target) return;
  cancelActiveScrollWrites();
  following.value = false;
  showPill.value = distanceFromBottom() > BOTTOM_THRESHOLD;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

// --- Scroll anchoring for expand/collapse interactions ----------------------
// Toggling a tool row/group grows or shrinks its body, which would otherwise move
// the viewport: a collapse near the bottom shrinks scrollHeight and lets the
// browser clamp scrollTop, and the auto-follow may snap to the tail. While the
// transition runs we pin the toggled row's viewport position and suppress the
// auto-follow, so the row stays put and only its body opens downward / collapses
// upward.
let pinUntil = 0;
let pinRaf = 0;
let pinEl: HTMLElement | null = null;
let pinTargetTop = 0;

function isPinned(): boolean {
  return performance.now() < pinUntil;
}

function pinScrollFor(el: HTMLElement, ms = 260): void {
  const panes = panesRef.value;
  if (!panes) return;
  pinEl = el;
  pinTargetTop = el.getBoundingClientRect().top;
  pinUntil = performance.now() + ms;
  if (pinRaf) return;
  const tick = () => {
    pinRaf = 0;
    if (performance.now() >= pinUntil || !pinEl) {
      pinEl = null;
      return;
    }
    const delta = pinEl.getBoundingClientRect().top - pinTargetTop;
    if (delta) panes.scrollTop += delta;
    pinRaf = raf(tick);
  };
  pinRaf = raf(tick);
}

function scheduleStableFollow(maxFrames = 36): void {
  if (!following.value && !hasUserActionFollowLock()) return;
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
    if (!following.value && !hasUserActionFollowLock()) return;
    scrollToBottom(false);
    const key = currentLayoutKey();
    stableFrames = key === lastKey ? stableFrames + 1 : 0;
    lastKey = key;
    frames++;
    if (stableFrames < 3 && frames < maxFrames) {
      stableFollowRaf = raf(tick);
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
  const approvalIds = (props.approvals ?? []).map((a) => a.approvalId).join(',');
  const t = props.turns;
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

watch(scrollKey, async (next, prev) => {
  // Prepending older history changes this key; suppress only that exact case so
  // concurrent bottom appends still raise the new-message pill.
  if (historyLoadInProgress.value && isHistoryPrependOnly(prev, next)) {
    updateActiveTocQuery();
    return;
  }
  await nextTick();
  if (following.value || hasUserActionFollowLock()) {
    // A rewind (undo / compaction) shortens the transcript — glide to the new
    // bottom smoothly; growth (new turns / streaming) snaps instantly so the
    // follow keeps up with the tail.
    scrollToBottom(next.length < prev.length);
  } else showPill.value = true;
  updateActiveTocQuery();
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

// Per-session scroll state: switching back to a session restores both the scroll
// position and whether the user was following the bottom, instead of always
// jumping to the bottom (which replayed the conversation when the session was
// already there) or getting yanked to the bottom by a new message after
// restoring a scrolled-up position.
const scrollStateBySession = new Map<string, { top: number; following: boolean }>();

watch(
  () => props.fileReloadKey,
  async (newKey, oldKey) => {
    const el = panesRef.value;
    if (oldKey && el) {
      scrollStateBySession.set(String(oldKey), { top: el.scrollTop, following: following.value });
    }
    cancelActiveScrollWrites();
    await nextTick();
    const el2 = panesRef.value;
    const saved = newKey ? scrollStateBySession.get(String(newKey)) : undefined;
    if (saved && el2) {
      const pendingRestore = pendingHistoryRestoreBySession.get(String(newKey));
      const top = pendingRestore
        ? restoreHistoryScroll(el2, pendingRestore, saved.top)
        : saved.top;
      if (pendingRestore) pendingHistoryRestoreBySession.delete(String(newKey));
      following.value = saved.following;
      el2.scrollTop = top;
      lastScrollTop = el2.scrollTop;
      showPill.value = !saved.following && distanceFromBottom() > 1;
      if (saved.following) {
        scheduleStableFollow();
      }
    } else {
      following.value = true;
      lastScrollTop = 0;
      scrollToBottom(false);
      scheduleStableFollow();
    }
    updateActiveTocQuery();
  },
);

watch(
  () => props.sessionLoading,
  async (loading, was) => {
    if (loading || !was) return;
    following.value = true;
    await nextTick();
    scheduleStableFollow();
    updateActiveTocQuery();
  },
);

watch(
  // Settle the scroll-follow when the conversation's turn finishes (not when
  // background-only work ends — the transcript didn't move then).
  () => props.turnActive,
  async (now, was) => {
    if (now || !was) return;
    if (!following.value && !hasUserActionFollowLock()) return;
    await nextTick();
    scheduleStableFollow(48);
    updateActiveTocQuery();
  },
);

function followAfterUserAction(): void {
  following.value = true;
  showPill.value = false;
  userActionFollowUntil = Date.now() + USER_ACTION_FOLLOW_LOCK_MS;
  void nextTick(() => {
    scrollToBottom(true);
    scheduleStableFollow(16);
  });
}

function handleComposerSubmit(payload: { text: string; attachments: PromptAttachment[] }): void {
  followAfterUserAction();
  emit('submit', payload);
}

// Undo ("edit & resend") rewinds the transcript asynchronously — the server
// round-trip in App.vue's handleEditMessage truncates the turns after this emit
// returns. Scrolling here would target the pre-rewind bottom and fight the
// bubble-exit animation, so we only arm the follow state; the scrollKey watcher
// smooth-scrolls once the truncated turns actually land.
function handleEditMessage(payload: {
  text: string;
  attachments?: TurnAttachment[];
}): void {
  following.value = true;
  showPill.value = false;
  userActionFollowUntil = Date.now() + USER_ACTION_FOLLOW_LOCK_MS;
  emit('editMessage', payload);
}

// A queued message was clicked for editing: load its text (and any attachments)
// back into the active composer, then let the parent dequeue it (mirrors the old
// dock-queue flow). Only dequeue when the load actually succeeds — if the dock is
// showing a pending question/approval the composer is hidden and the load no-ops,
// so dequeuing would drop the prompt instead of making it editable.
function handleEditQueued(index: number): void {
  const item = props.queued?.[index];
  const text = item?.text ?? '';
  const loaded = loadComposerForEdit(text, item?.attachments);
  if (loaded) emit('editQueued', index);
}

function handleReorderQueue(payload: { from: number; to: number }): void {
  emit('reorderQueue', payload);
}

function handleQuestionAnswer(qid: string, resp: QuestionResponse): void {
  followAfterUserAction();
  emit('answer', qid, resp);
}

function handleApproval(
  id: string | undefined,
  response: { decision: 'approved' | 'rejected' | 'cancelled'; scope?: 'session'; feedback?: string } | undefined,
): void {
  if (!id || !response) return;
  emit('approval', id, response);
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
  const el = panesRef.value;

  userActionFollowUntil = 0;
  cancelScheduledFollow();
  pinUntil = 0;
  pinEl = null;

  if (el) {
    const top = el.scrollTop;
    if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: 'auto' });
    else el.scrollTop = top;
  }
  smoothScrollUntil = 0;
  lastSmoothScroll = Number.NEGATIVE_INFINITY;
  if (el) lastScrollTop = el.scrollTop;
}

// Wheel, touch, and scrollbar input arrive before the browser dispatches
// `scroll`. Stop queued writers before they can overwrite the user's movement.
function stopFollowingForUserIntent(): void {
  const el = panesRef.value;
  if (!el || (el.scrollHeight - el.clientHeight <= 1 && !props.hasMoreMessages)) return;

  following.value = false;
  cancelActiveScrollWrites();
  if (el.scrollHeight - el.clientHeight > 1) showPill.value = true;
}

function nestedScrollerCanMoveUp(event: Event): boolean {
  const pane = panesRef.value;
  if (!pane) return false;
  for (const target of event.composedPath()) {
    if (target === pane) return false;
    if (
      target instanceof HTMLElement &&
      target.scrollHeight > target.clientHeight + 1 &&
      target.scrollTop > 1
    ) {
      return true;
    }
  }
  return false;
}

function onPanesWheel(event: WheelEvent): void {
  if (
    event.defaultPrevented ||
    event.ctrlKey ||
    event.shiftKey ||
    event.deltaY >= 0 ||
    nestedScrollerCanMoveUp(event)
  ) {
    return;
  }
  stopFollowingForUserIntent();
}

function onPanesPointerDown(event: PointerEvent): void {
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
  // The finger moving down means the scroll container is moving up.
  if (
    y !== null &&
    lastTouchY !== null &&
    y > lastTouchY + 2 &&
    !nestedScrollerCanMoveUp(event)
  ) {
    stopFollowingForUserIntent();
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
  scheduleTocTableHitTest();
}

function onContentMutated(): void {
  ensureContentObserved();
  scheduleFollow();
  scheduleTocTableHitTest();
}

function onVisibilityChange(): void {
  if (typeof document === 'undefined') return;
  if (document.visibilityState === 'visible' && following.value) {
    scheduleStableFollow();
  }
}

// ---------------------------------------------------------------------------
// Manual-abort toast: shown when the user presses Escape to stop the prompt
// ---------------------------------------------------------------------------
const abortToastVisible = ref(false);
let abortToastTimer: ReturnType<typeof setTimeout> | null = null;
const ABORT_TOAST_DURATION = 3000;

function showAbortToast(): void {
  abortToastVisible.value = true;
  if (abortToastTimer !== null) clearTimeout(abortToastTimer);
  abortToastTimer = setTimeout(() => {
    abortToastVisible.value = false;
  }, ABORT_TOAST_DURATION);
}

function handleInterrupt(): void {
  showAbortToast();
  emit('interrupt');
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && (props.running || props.working)) {
    event.preventDefault();
    handleInterrupt();
  }
}

// When the on-screen keyboard opens, browsers without interactive-widget support
// fire a visualViewport resize instead of shrinking the layout viewport. Re-follow
// the tail so the latest turn stays visible above the keyboard. No-op while the
// user has manually scrolled away (following === false).
function onVisualViewportResize(): void {
  if (following.value) scheduleFollow();
}

onMounted(() => {
  nextTick(() => {
    if (typeof MutationObserver === 'function') {
      contentObserver = new MutationObserver(onContentMutated);
    }
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        scheduleTocTableHitTest();
        updatePanesScrollbarWidth();
        const el = panesRef.value;
        if (!el) return;
        const { scrollHeight, clientHeight } = el;
        const grew = scrollHeight > lastObservedScrollHeight + 1;
        const viewportShrank = clientHeight < lastObservedClientHeight - 1;
        lastObservedScrollHeight = scrollHeight;
        lastObservedClientHeight = clientHeight;
        // Follow the tail on genuine growth (new turns, streaming, or late-loading
        // media that gain height after scrollKey has already run) or a shrinking
        // viewport (composer dock growing and hiding the last message). While a tool
        // row/group is being toggled (the pinned window) suppress follow entirely,
        // so the row opens downward / collapses upward without moving the viewport.
        if (!isPinned() && (grew || viewportShrank)) scheduleFollow();
      });
    }
    rebindScrollObservers();
    scheduleStableFollow(48);
    updateActiveTocQuery();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
      document.addEventListener('keydown', onKeyDown);
    }
    window.visualViewport?.addEventListener('resize', onVisualViewportResize);
  });
});

onUnmounted(() => {
  if (contentObserver) contentObserver.disconnect();
  if (resizeObserver) resizeObserver.disconnect();
  if (scrollRaf) cancelRaf(scrollRaf);
  if (stableFollowRaf) cancelRaf(stableFollowRaf);
  if (pinRaf) cancelRaf(pinRaf);
  if (tocHitTestRaf) cancelRaf(tocHitTestRaf);
  if (abortToastTimer !== null) clearTimeout(abortToastTimer);
  if (copyConversationCopiedTimer !== null) {
    clearTimeout(copyConversationCopiedTimer);
    copyConversationCopiedTimer = null;
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('keydown', onKeyDown);
  }
  window.visualViewport?.removeEventListener('resize', onVisualViewportResize);
});

function focusComposer(): void {
  (dockedComposerRef.value ?? emptyComposerRef.value)?.focus();
}

defineExpose({ loadComposerForEdit, focusComposer });
</script>

<template>
  <section class="con" :class="{ mobile }">
    <!-- Chat context header: workspace/session, git status, open-in-editor,
         copy-all, PR. Hidden for the empty-composer (no session context yet). -->
    <ChatHeader
      v-if="!mobile && !(turns.length === 0 && !sessionLoading)"
      :session-id="sessionId"
      :workspace-name="workspaceName"
      :workspace-root="workspaceRoot"
      :session-title="sessionTitle"
      :branch="gitInfo?.branch"
      :ahead="gitInfo?.ahead"
      :behind="gitInfo?.behind"
      :changes-count="changesCount"
      :git-diff-stats="gitDiffStats"
      :is-git-repo="!!gitInfo"
      :pr="pr"
      :copied="copyConversationCopied"
      @open-changes="emit('openChanges')"
      @copy-all="chatPaneRef?.copyConversation()"
      @copy-final-summary="chatPaneRef?.copyFinalSummary()"
      @open-pr="pr && emit('openPr', pr.url)"
      @rename-session="(id, title) => emit('renameSession', id, title)"
      @fork-session="(id) => emit('forkSession', id)"
      @archive-session="(id) => emit('archiveSession', id)"
      @export-session="(id) => emit('exportSession', id)"
    />

    <!-- Conversation outline: right edge rail of vertical bars (one per user
         query); hover to expand a labeled panel. -->
    <ConversationToc
      v-if="conversationToc"
      :items="conversationTocItems"
      :active-turn-id="activeTurnId"
      :mobile="mobile"
      :session-loading="sessionLoading"
      :occluded="tocOccludedByTable"
      @select="scrollToTurn"
    />

    <div class="chat-layout">
      <div
        :ref="bindChatPane"
        class="panes chat-scroll"
        :class="{
          'is-following': following,
          'history-prepending': historyLoadInProgress,
        }"
        @scroll.passive="onPanesScroll"
        @wheel.passive="onPanesWheel"
        @pointerdown.passive="onPanesPointerDown"
        @touchstart.passive="onPanesTouchStart"
        @touchmove.passive="onPanesTouchMove"
      >
        <div class="content-wrap" :class="[mobile ? 'align-mobile' : 'align-center']">
          <template v-if="turns.length === 0 && !sessionLoading">
            <!-- Empty session: Composer rendered in the centre of the pane -->
            <div class="empty-spacer" />
            <div class="empty-hint">
              <span class="empty-hint-title" :class="{ 'is-starting': starting }">
                <Spinner v-if="starting" size="sm" />
                <span>{{ starting ? t('conversation.starting') : t('composer.emptyConversationTitle') }}</span>
              </span>
              <span v-if="!starting" class="empty-hint-text">{{ t('composer.emptyConversation') }}</span>
              <!-- Workspace picker: choose where this new conversation starts.
                   Hidden while starting — a workspace is already committed. -->
              <div v-if="hasWorkspaces && !starting" class="ws-pick">
                <Tooltip :text="t('conversation.switchWorkspace')">
                  <button type="button" class="ws-pick-btn" @click.stop="wsPickOpen = !wsPickOpen">
                    <Icon name="folder" size="sm" />
                    <span class="ws-pick-name">{{ activeWorkspaceLabel }}</span>
                    <Icon class="ws-pick-chev" :class="{ open: wsPickOpen }" name="chevron-down" size="sm" />
                  </button>
                </Tooltip>
                <div v-if="wsPickOpen" class="ws-pick-backdrop" @click="wsPickOpen = false" />
                <div v-if="wsPickOpen" class="ws-pick-menu">
                  <button
                    v-for="w in visibleWorkspaces"
                    :key="w.id"
                    type="button"
                    class="ws-pick-item"
                    :class="{ on: w.id === activeWorkspaceId }"
                    @click.stop="pickWorkspace(w.id)"
                  >
                    <span class="ws-pick-item-name">{{ w.name }}</span>
                    <span class="ws-pick-item-path">{{ w.shortPath }}</span>
                  </button>
                  <button
                    v-if="hiddenWorkspaceCount > 0"
                    type="button"
                    class="ws-pick-item ws-pick-more"
                    @click.stop="wsPickExpanded = !wsPickExpanded"
                  >
                    <span>{{ t('conversation.moreWorkspaces', { count: hiddenWorkspaceCount }) }}</span>
                  </button>
                  <div class="ws-pick-divider" />
                  <button
                    type="button"
                    class="ws-pick-action"
                    @click.stop="wsPickOpen = false; emit('addWorkspace')"
                  >
                    <Icon name="plus" size="sm" />
                    <span>{{ t('conversation.addWorkspace') }}</span>
                  </button>
                </div>
              </div>
              <button
                v-else-if="!starting"
                type="button"
                class="empty-add-workspace"
                @click="emit('addWorkspace')"
              >
                <Icon name="folder-plus" size="sm" />
                <span>{{ t('conversation.addWorkspace') }}</span>
              </button>
            </div>
            <Composer
              ref="emptyComposerRef"
              class="empty-composer"
              :session-id="sessionId"
              :running="running"
              :queued="queued"
              :search-files="searchFiles"
              :upload-image="uploadImage"
              :status="status"
              :thinking="thinking"
              :plan-mode="planMode"
              :swarm-mode="swarmMode"
              :goal-mode="goalMode"
              :goal="goal"
              :activation-badges="activationBadges"
              :models="models"
              :starred-ids="starredIds"
              :skills="skills"
              :starting="starting"
              hide-context
              @submit="handleComposerSubmit"
              @steer="emit('steer', $event)"
              @command="emit('command', $event)"
              @interrupt="handleInterrupt"
              @unqueue="emit('unqueue', $event)"
              @edit-queued="emit('editQueued', $event)"
              @set-permission="emit('setPermission', $event)"
              @set-thinking="emit('setThinking', $event)"
              @toggle-plan="emit('togglePlan')"
              @toggle-swarm="emit('toggleSwarm')"
              @toggle-goal="emit('toggleGoal')"
              @open-btw="emit('command', '/btw')"
              @create-goal="emit('createGoal', $event)"
              @control-goal="emit('controlGoal', $event)"
              @focus-goal="focusGoal"
              @compact="emit('compact')"
              @pick-model="emit('pickModel')"
              @select-model="emit('selectModel', $event)"
            />
            <div class="empty-spacer" />
          </template>
          <template v-else>
            <ChatPane
              ref="chatPaneRef"
              :key="fileReloadKey ?? 'no-session'"
              :turns="turns"
              :approvals="approvals"
              :turn-active="turnActive"
              :working="working"
              :fast-moon="fastMoon"
              :session-loading="sessionLoading"
              :compaction="compaction"
              :has-more-messages="hasMoreMessages"
              :loading-more="loadingMore"
              :loading-more-error="loadingMoreError"
              :is-following="following"
              :tool-diff-panel="true"
              :queued="queued"
              @open-file="emit('openFile', $event)"
              @open-media="emit('openMedia', $event)"
              @copy-conversation-copied="handleCopyConversationCopied"
              @open-thinking="emit('openThinking', $event)"
              @open-compaction="emit('openCompaction', $event)"
              @open-agent="emit('openAgent', $event)"
              @open-tool-diff="emit('openToolDiff', $event)"
              @edit-message="handleEditMessage"
              @load-older-messages="handleLoadOlderMessages"
              @unqueue="emit('unqueue', $event)"
              @edit-queued="handleEditQueued"
              @reorder-queue="handleReorderQueue"
            />
          </template>
        </div>
      </div>
      <ChatDock
        v-if="!(turns.length === 0 && !sessionLoading)"
        :ref="bindChatDock"
        :style="chatDockStyle"
        :session-id="sessionId"
        :running="running"
        :starting="starting"
        :queued="queued"
        :search-files="searchFiles"
        :upload-image="uploadImage"
        :status="status"
        :thinking="thinking"
        :plan-mode="planMode"
        :swarm-mode="swarmMode"
        :goal-mode="goalMode"
        :activation-badges="activationBadges"
        :models="models"
        :starred-ids="starredIds"
        :skills="skills"
        :goal="goal"
        :goal-expand-signal="goalExpandSignal"
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
        @toggle-dock-panel="toggleDockPanel($event)"
        @close-dock-panel="closeDockPanel()"
        @open-agent="emit('openAgent', $event)"
        @answer="handleQuestionAnswer"
        @dismiss="emit('dismiss', $event)"
        @approval="handleApproval"
        @cancel-task="emit('cancelTask', $event)"
        @control-goal="emit('controlGoal', $event)"
        @submit="handleComposerSubmit"
        @steer="emit('steer', $event)"
        @command="emit('command', $event)"
        @interrupt="handleInterrupt"
        @set-permission="emit('setPermission', $event)"
        @set-thinking="emit('setThinking', $event)"
        @toggle-plan="emit('togglePlan')"
        @toggle-swarm="emit('toggleSwarm')"
        @toggle-goal="emit('toggleGoal')"
          @open-btw="emit('command', '/btw')"
          @create-goal="emit('createGoal', $event)"
          @focus-goal="focusGoal"
          @compact="emit('compact')"
          @pick-model="emit('pickModel')"
          @select-model="emit('selectModel', $event)"
      />
    </div>

    <!-- "New messages" pill — only visible when scrolled up and new content arrives. -->
    <Transition name="pill">
      <button
        v-if="showPill"
        class="newmsg-pill"
        :style="{ bottom: `${dockHeight + 12}px` }"
        :aria-label="t('conversation.jumpToLatestAria')"
        @click="scrollToBottom(true)"
      >
        <Icon class="pill-chevron" name="chevron-down" size="md" />
        {{ t('conversation.newMessages') }}
      </button>
    </Transition>

    <!-- Manual-abort toast: shown when the user presses Escape to stop a prompt -->
    <Transition name="abort-toast">
      <div
        v-if="abortToastVisible"
        class="abort-toast"
        role="status"
        aria-live="polite"
      >
        <span class="abort-toast-text">{{ t('conversation.manuallyAborted') }}</span>
      </div>
    </Transition>
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

.panes {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* Keep the visible message stable while the user browses history. Bottom
     following and history prepend use explicit scroll writes, so they opt out. */
  overflow-anchor: auto;
  scrollbar-gutter: stable;
}

.panes.is-following,
.panes.history-prepending {
  overflow-anchor: none;
}

/* Chat tab layout: the message list scrolls, while the dock stays as the
   bottom sibling inside the same chat pane. */
.chat-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  position: relative;
}
.chat-scroll {
  flex: 1;
  min-height: 0;
  position: relative;
}

/* Chat reading column max-width + alignment. */
.content-wrap {
  width: 100%;
  max-width: var(--read-max);
  min-height: 100%;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.content-wrap.align-center { margin-left: auto; margin-right: auto; }
.content-wrap.align-left { margin-left: 0; margin-right: auto; }
/* Mobile: bubbles span the full pane width; no reading-column constraint. */
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

/* Empty-workspace spacers: push the centred Composer to the vertical middle. */
.empty-spacer { flex: 1; }

/* Empty-session hint above the centred composer */
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
.empty-hint-text {
  display: inline-block;
  font-size: var(--text-base);
  color: var(--dim);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty-add-workspace {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 34px;
  padding: 7px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--dim);
  font-family: var(--mono);
  font-size: var(--ui-font-size-sm);
  cursor: pointer;
}
.empty-add-workspace:hover {
  border-color: var(--color-accent-bd);
  color: var(--color-text);
}
.empty-add-workspace:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.empty-add-workspace svg {
  flex: none;
}

/* Empty-composer workspace picker */
.ws-pick {
  position: relative;
  font-family: var(--font-ui);
}
.ws-pick-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  width: max-content;
  max-width: min(100%, calc(100vw - var(--space-8)));
  padding: 5px 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--dim);
  font-family: inherit;
  font-size: var(--ui-font-size-sm);
  cursor: pointer;
}
.ws-pick-btn:hover { border-color: var(--color-accent-bd); color: var(--color-text); }
.ws-pick-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-pick-chev { flex: none; color: var(--muted); transition: transform 0.15s; }
.ws-pick-chev.open { transform: rotate(180deg); }
.ws-pick-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-sticky);
}
.ws-pick-menu {
  position: absolute;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  left: 50%;
  transform: translateX(-50%);
  top: calc(100% + 6px);
  z-index: var(--z-dropdown);
  width: max-content;
  min-width: min(180px, calc(100cqw - var(--space-8)));
  max-width: calc(100cqw - var(--space-8));
  max-height: 50vh;
  overflow: hidden auto;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  padding: 4px;
}
.ws-pick-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-radius: 6px;
  padding: 6px 10px;
  cursor: pointer;
  font-family: var(--font-ui);
}
.ws-pick-item:hover { background: var(--panel2); }
.ws-pick-item.on { background: var(--color-accent-soft); }
.ws-pick-item-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.ws-pick-item.on .ws-pick-item-name { color: var(--color-accent-hover); }
.ws-pick-item-path {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  font-weight: 475;
  color: var(--muted);
}
.ws-pick-item.ws-pick-more {
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--dim);
}
.ws-pick-item.ws-pick-more:hover { color: var(--color-text); }
.ws-pick-item.ws-pick-more span,
.ws-pick-action span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-pick-divider {
  height: 1px;
  margin: 4px 6px;
  background: var(--line);
}
.ws-pick-action {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-radius: 6px;
  padding: 7px 10px;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--dim);
}
.ws-pick-action:hover { background: var(--panel2); color: var(--color-text); }
.ws-pick-action svg { flex: none; }

/* Chat scroll area: owns only messages; the dock is the bottom sibling. */
.chat-scroll {
  display: flex;
  flex-direction: column;
}

/* Mobile shell: the outer .panes is just a flex host; the actual chat scroll is
   .chat-scroll inside it. Avoid a double scrollbar gutter on the chat tab. */
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
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--color-text);
  font-size: var(--ui-font-size-sm);
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  /* Positioned after the message flow, so base z-index is enough to float above
     content while staying below composer dropdowns. */
  z-index: var(--z-base);
}
.newmsg-pill:hover { background: var(--panel2); }
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

.abort-toast {
  position: absolute;
  left: 50%;
  top: 60px;
  transform: translateX(-50%);
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  background: var(--color-text);
  color: var(--bg);
  font-size: var(--ui-font-size-sm);
  z-index: var(--z-sticky);
  box-shadow: var(--shadow-sm);
}
.abort-toast-text {
  display: flex;
  align-items: center;
  gap: 8px;
}
.abort-toast-enter-active,
.abort-toast-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.abort-toast-enter-from,
.abort-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-6px);
}

.con { background: var(--bg); }
.newmsg-pill { font-family: var(--sans); }
</style>
