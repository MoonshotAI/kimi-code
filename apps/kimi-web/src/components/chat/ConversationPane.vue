<!-- apps/kimi-web/src/components/chat/ConversationPane.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ActivationBadges, ApprovalBlock, ChatTurn, ConversationStatus, FilePreviewRequest, PermissionMode, QueuedPromptView, TaskItem, TodoView, ToolMedia, UIQuestion, WorkspaceView } from '../../types';
import type { AppGoal, AppModel, AppSkill, QuestionResponse, ThinkingLevel } from '../../api/types';
import type { FileItem } from './MentionMenu.vue';
import ChatPane from './ChatPane.vue';
import ChatHeader from './ChatHeader.vue';
import Composer from './Composer.vue';
import ChatDock from './ChatDock.vue';
import ConversationToc, { type ConversationTocItem } from './ConversationToc.vue';
import Icon from '../ui/Icon.vue';
import Tooltip from '../ui/Tooltip.vue';
import { getVisibleWorkspaces } from '../../lib/workspacePicker';
import { safeRemove, STORAGE_KEYS } from '../../lib/storage';

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
  running?: boolean;
  queued?: QueuedPromptView[];
  searchFiles?: (q: string) => Promise<FileItem[]>;
  uploadImage?: (file: Blob, name?: string) => Promise<{ fileId: string; name: string; mediaType: string } | null>;
  /** Git changed files (only used for the header diff counter dot). */
  changes?: { path: string; status: string }[];
  /** Cache-buster that remounts the chat pane when the active session changes. */
  fileReloadKey?: string | number;
  sending?: boolean;
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
  submit: [payload: { text: string; attachments: { fileId: string; kind: 'image' | 'video' }[] }];
  steer: [payload: { text: string; attachments: { fileId: string; kind: 'image' | 'video' }[] }];
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
  editMessage: [payload: { text: string; images?: { url: string; alt?: string; kind: 'image' | 'video'; fileId?: string }[] }];
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

const { t } = useI18n();

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
  attachments?: { fileId?: string; kind: 'image' | 'video'; url: string; name?: string }[],
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
  loadAttachmentsForEdit: (atts: { fileId?: string; kind: 'image' | 'video'; url: string; name?: string }[]) => void;
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
  const el = panesRef.value;
  if (!el) return;
  const top = el.scrollTop;

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

function findTopAnchor(
  container: HTMLElement,
  scrollTop: number,
): { id: string; top: number } | null {
  const anchors = container.querySelectorAll<HTMLElement>('.turn-anchor');
  for (const anchor of anchors) {
    if (anchor.offsetTop >= scrollTop) {
      const id = anchor.dataset.turnId;
      if (id) return { id, top: anchor.offsetTop };
    }
  }
  return null;
}

async function handleLoadOlderMessages(): Promise<void> {
  if (
    !props.sessionId ||
    !props.loadOlderMessages ||
    props.loadingMore ||
    !props.hasMoreMessages
  ) {
    return;
  }
  const requestedSessionId = props.sessionId;
  const el = panesRef.value;
  const oldTop = el?.scrollTop ?? 0;
  const oldHeight = el?.scrollHeight ?? 0;
  const oldAnchor = el ? findTopAnchor(el, oldTop) : null;

  historyLoadInProgress.value = true;
  try {
    await props.loadOlderMessages(requestedSessionId);
    await nextTick();
  } finally {
    historyLoadInProgress.value = false;
  }

  // If the user switched sessions while the request was in flight, do not
  // restore scroll position on the newly selected session's pane.
  if (props.sessionId !== requestedSessionId) return;

  const el2 = panesRef.value;
  if (!el2) return;

  // Restore scroll position using a stable anchor near the old viewport top.
  // This isolates height inserted above the anchor and ignores any new bottom
  // content (e.g. streaming assistant turns) that arrived during the request.
  let delta = 0;
  if (oldAnchor) {
    const newAnchor = el2.querySelector<HTMLElement>(
      `.turn-anchor[data-turn-id="${attrEscape(oldAnchor.id)}"]`,
    );
    if (newAnchor) {
      delta = newAnchor.offsetTop - oldAnchor.top;
    }
  }
  // If the page boundary split an assistant/tool turn, messagesToTurns may
  // rebuild that turn with a new id. Fall back to the overall height delta so
  // the viewport does not jump into the inserted history.
  if (delta === 0) delta = el2.scrollHeight - oldHeight;
  el2.scrollTop = oldTop + delta;
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
    await nextTick();
    const el2 = panesRef.value;
    const saved = newKey ? scrollStateBySession.get(String(newKey)) : undefined;
    if (saved && el2) {
      following.value = saved.following;
      el2.scrollTop = saved.top;
      lastScrollTop = saved.top;
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
  () => props.running,
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

function handleComposerSubmit(payload: { text: string; attachments: { fileId: string; kind: 'image' | 'video' }[] }): void {
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
  images?: { url: string; alt?: string; kind: 'image' | 'video'; fileId?: string }[];
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
let scrollRaf = 0;
let pillEligible = false;
const historyLoadInProgress = ref(false);

function scheduleFollow(allowPill: boolean): void {
  // Prepending older history changes turns.length but is not new bottom content;
  // suppress the "new messages" pill until the scroll position is restored.
  if (historyLoadInProgress.value) return;
  pillEligible = pillEligible || allowPill;
  if (scrollRaf) return;
  const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16) as unknown as number;
  scrollRaf = schedule(() => {
    scrollRaf = 0;
    const wantPill = pillEligible;
    pillEligible = false;
    if (following.value || hasUserActionFollowLock()) scrollToBottom(false);
    else if (wantPill) showPill.value = true;
  }) as unknown as number;
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
}

function onContentMutated(): void {
  ensureContentObserved();
  scheduleFollow(true);
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
  if (event.key === 'Escape' && (props.running || props.sending)) {
    event.preventDefault();
    handleInterrupt();
  }
}

onMounted(() => {
  nextTick(() => {
    if (typeof MutationObserver === 'function') {
      contentObserver = new MutationObserver(onContentMutated);
    }
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        updatePanesScrollbarWidth();
        scheduleFollow(false);
      });
    }
    rebindScrollObservers();
    scheduleStableFollow(48);
    updateActiveTocQuery();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
      document.addEventListener('keydown', onKeyDown);
    }
  });
});

onUnmounted(() => {
  if (contentObserver) contentObserver.disconnect();
  if (resizeObserver) resizeObserver.disconnect();
  if (scrollRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scrollRaf);
  if (stableFollowRaf) cancelRaf(stableFollowRaf);
  if (abortToastTimer !== null) clearTimeout(abortToastTimer);
  if (copyConversationCopiedTimer !== null) {
    clearTimeout(copyConversationCopiedTimer);
    copyConversationCopiedTimer = null;
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('keydown', onKeyDown);
  }
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
    />

    <!-- Conversation outline: right edge rail of vertical bars (one per user
         query); hover to expand a labeled panel. -->
    <ConversationToc
      v-if="conversationToc"
      :items="conversationTocItems"
      :active-turn-id="activeTurnId"
      :mobile="mobile"
      :session-loading="sessionLoading"
      @select="scrollToTurn"
    />

    <div class="chat-layout">
      <div
        :ref="bindChatPane"
        class="panes chat-scroll"
        @scroll.passive="onPanesScroll"
      >
        <div class="content-wrap" :class="[mobile ? 'align-mobile' : 'align-center']">
          <template v-if="turns.length === 0 && !sessionLoading">
            <!-- Empty session: Composer rendered in the centre of the pane -->
            <div class="empty-spacer" />
            <div class="empty-hint">
              <span class="empty-hint-title">{{ t('composer.emptyConversationTitle') }}</span>
              <span class="empty-hint-text">{{ t('composer.emptyConversation') }}</span>
              <!-- Workspace picker: choose where this new conversation starts. -->
              <div v-if="hasWorkspaces" class="ws-pick">
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
                v-else
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
              :activation-badges="activationBadges"
              :models="models"
              :starred-ids="starredIds"
              :skills="skills"
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
              :running="running"
              :sending="sending"
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
  overflow-anchor: none;
  scrollbar-gutter: stable;
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
  font-family: var(--sans);
}
.empty-hint-title {
  font-size: calc(var(--ui-font-size) + 16px);
  font-weight: 500;
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
  font-family: var(--mono);
}
.ws-pick-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 320px;
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
.ws-pick-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-pick-chev { flex: none; color: var(--muted); transition: transform 0.15s; }
.ws-pick-chev.open { transform: rotate(180deg); }
.ws-pick-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-sticky);
}
.ws-pick-menu {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  top: calc(100% + 6px);
  z-index: var(--z-dropdown);
  min-width: 220px;
  max-width: min(86vw, 340px);
  max-height: 50vh;
  overflow-y: auto;
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
  font-family: var(--mono);
}
.ws-pick-item:hover { background: var(--panel2); }
.ws-pick-item.on { background: var(--color-accent-soft); }
.ws-pick-item-name { font-size: var(--ui-font-size-sm); color: var(--color-text); }
.ws-pick-item.on .ws-pick-item-name { color: var(--color-accent-hover); font-weight: 500; }
.ws-pick-item-path { font-size: var(--text-base); color: var(--muted); }
.ws-pick-item.ws-pick-more {
  flex-direction: row;
  justify-content: center;
  color: var(--dim);
}
.ws-pick-item.ws-pick-more:hover { color: var(--color-text); }
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
  font-family: var(--mono);
  font-size: var(--ui-font-size-sm);
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
  z-index: var(--z-sticky);
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
