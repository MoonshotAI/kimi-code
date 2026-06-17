<!-- apps/kimi-web/src/components/ConversationPane.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ActivationBadges, ApprovalBlock, ChatTurn, ConversationStatus, FilePreviewRequest, PermissionMode, QueuedPromptView, TaskItem, TodoView, ToolMedia, UIQuestion, WorkspaceView } from '../types';
import type { AppGoal, AppModel, AppSkill, QuestionResponse, ThinkingLevel } from '../api/types';
import type { SwarmGroup } from '../composables/swarmGroups';
import type { FileItem } from './MentionMenu.vue';
import ChatPane from './ChatPane.vue';
import ChatHeader from './ChatHeader.vue';
import Composer from './Composer.vue';
import SwarmCard from './SwarmCard.vue';
import ChatDock from './ChatDock.vue';
import { getVisibleWorkspaces } from '../lib/workspacePicker';

const props = defineProps<{
  turns: ChatTurn[];
  sessionId?: string;
  approvals?: { approvalId: string; block: ApprovalBlock; agentName?: string }[];
  gitInfo?: { branch: string; ahead: number; behind: number } | null;
  tasks: TaskItem[];
  /** Model-maintained todo list (TodoList tool) — shown as a floating card. */
  todos?: TodoView[];
  goal?: AppGoal | null;
  swarms?: SwarmGroup[];
  activationBadges?: ActivationBadges;
  status: ConversationStatus;
  thinking?: ThinkingLevel;
  planMode?: boolean;
  swarmMode?: boolean;
  goalMode?: boolean;
  questions?: UIQuestion[];
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
  /** Bubble themes (Modern/Kimi): render chat bubbles at all widths (desktop included). */
  modern?: boolean;
  /** True while switching sessions and the turns array is not yet loaded. */
  sessionLoading?: boolean;
  /** Live compaction state of the active session (non-null while running). */
  compaction?: { status: 'running' } | null;
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
  /** Beta conversation outline: proportional bubbles, viewport indicator, hover tooltip. */
  betaToc?: boolean;
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
  openAgent: [target: { turnId: string; blockIndex: number; memberId: string }];
  /** Chat header / files pane: focus the diff detail layer and refresh git status. */
  openChanges: [];
  refreshGitStatus: [];
  /** Edit + resend the last user message (App undoes, then refills composer). */
  editMessage: [text: string];
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

/** Swarm cards are live progress indicators: keep the bottom stack only while
    at least one member is still queued, working, or suspended. Once every
    member has finished (completed or failed), the card is no longer useful as
    a persistent footer and is removed from the stack. */
const activeSwarms = computed<SwarmGroup[]>(() => {
  return (
    props.swarms?.filter((group) =>
      group.members.some((member) => member.phase !== 'completed' && member.phase !== 'failed'),
    ) ?? []
  );
});

function pickWorkspace(id: string): void {
  wsPickOpen.value = false;
  if (id !== props.activeWorkspaceId) emit('selectWorkspace', id);
}

const { t } = useI18n();

// The align toggle was removed with its UI (6e50cb7) — reading layout is
// always centered now. Drop the old persisted preference so users who once
// picked 'left' aren't frozen on it with no way back.
try {
  localStorage.removeItem('kimi-web.content-align');
} catch {
  // localStorage unavailable
}

const chatPaneRef = ref<InstanceType<typeof ChatPane> | null>(null);
const emptyComposerRef = ref<{ loadForEdit: (v: string) => void } | null>(null);
const dockedComposerRef = ref<{ loadForEdit: (v: string) => void } | null>(null);
const copyConversationCopied = ref(false);
const goalExpandSignal = ref(0);
let copyConversationCopiedTimer: ReturnType<typeof setTimeout> | null = null;

/** Load text into whichever composer is currently mounted (docked vs the
    empty-session composer). Used by App for "edit & resend the last message". */
function loadComposerForEdit(value: string): void {
  (dockedComposerRef.value ?? emptyComposerRef.value)?.loadForEdit(value);
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

function focusSwarm(): void {
  void nextTick(() => {
    const first = panesRef.value?.querySelector<HTMLElement>('.swarm-card');
    first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

const bubble = computed(() => props.mobile === true || props.modern === true);

const bashTasks = computed(() => props.tasks.filter((t) => t.kind !== 'subagent'));
const subagentTasks = computed(() => props.tasks.filter((t) => t.kind === 'subagent'));
const bashRunning = computed(() => bashTasks.value.filter((t) => t.state === 'run').length);
const subagentRunning = computed(() => subagentTasks.value.filter((t) => t.state === 'run').length);
const todoDoneCount = computed(() => (props.todos ?? []).filter((td) => td.status === 'done').length);
const hasDockWork = computed(() =>
  props.tasks.length > 0 ||
  (props.todos?.length ?? 0) > 0 ||
  (props.queued?.length ?? 0) > 0,
);
const dockPanel = ref<'bash' | 'subagent' | 'todos' | 'queue' | null>(null);
const changesCount = computed(() => (props.gitInfo ? props.changes?.length ?? 0 : 0));

function toggleDockPanel(panel: 'bash' | 'subagent' | 'todos' | 'queue'): void {
  dockPanel.value = dockPanel.value === panel ? null : panel;
}

function closeDockPanel(): void {
  dockPanel.value = null;
}

watch(hasDockWork, (hasWork) => {
  if (!hasWork) closeDockPanel();
});

interface ConversationTocItem {
  id: string;
  role: ChatTurn['role'];
  no: number;
  title: string;
}

function tocTitle(turn: ChatTurn): string {
  if (turn.role === 'compaction') return t('conversation.compactedPlain');
  if (turn.role === 'user') {
    if (turn.skillActivation) return `/${turn.skillActivation.name}`;
    const text = turn.text.trim().replace(/\s+/g, ' ');
    return text.length > 0 ? text : 'user';
  }
  const text = (turn.text || turn.thinking || '').trim().replace(/\s+/g, ' ');
  if (text.length > 0) return text;
  if ((turn.tools?.length ?? 0) > 0) return `${turn.tools!.length} tools`;
  return 'kimi';
}

const conversationTocItems = computed<ConversationTocItem[]>(() =>
  props.turns.map((turn, index) => ({
    id: turn.id,
    role: turn.role,
    no: turn.no || index + 1,
    title: tocTitle(turn),
  })),
);

function turnContentLength(turn: ChatTurn): number {
  if (turn.role === 'compaction') return 20;
  if (turn.role === 'user') {
    return (turn.text?.length ?? 0) + (turn.skillActivation ? 20 : 0);
  }
  return (
    (turn.text?.length ?? 0) +
    (turn.thinking?.length ?? 0) +
    (turn.tools?.reduce(
      (n, tool) => n + tool.name.length + (tool.arg?.length ?? 0) + (tool.output?.join('').length ?? 0),
      0,
    ) ?? 0)
  );
}

const TOC_BUBBLE_MIN = 10;
const TOC_BUBBLE_MAX = 56;
const TOC_TRACK_HEIGHT = 420;

const tocMetrics = computed<{ id: string; height: number }[]>(() => {
  const items = conversationTocItems.value;
  const lengths = items.map((item) => {
    const turn = props.turns.find((t) => t.id === item.id);
    return turn ? turnContentLength(turn) : TOC_BUBBLE_MIN;
  });
  const total = lengths.reduce((s, n) => s + n, 0) || items.length * TOC_BUBBLE_MIN;
  return items.map((item, i) => {
    const len = lengths[i] ?? TOC_BUBBLE_MIN;
    const ratio = total > 0 ? len / total : 0;
    const height = Math.max(TOC_BUBBLE_MIN, Math.min(TOC_BUBBLE_MAX, ratio * TOC_TRACK_HEIGHT));
    return { id: item.id, height: Math.round(height) };
  });
});

const tocTotalHeight = computed(() =>
  tocMetrics.value.reduce((s, m) => s + m.height, 0) + (conversationTocItems.value.length - 1) * 4,
);

const activeTurnId = ref<string | null>(null);
const tocViewport = ref<{ top: number; height: number } | null>(null);
const tooltip = ref<{ visible: boolean; text: string; top: number }>({
  visible: false,
  text: '',
  top: 0,
});

function updateTocViewport(): void {
  const pane = panesRef.value;
  if (!pane) return;
  const anchors = pane.querySelectorAll<HTMLElement>('.turn-anchor[data-turn-id]');
  if (!anchors.length) return;
  const paneRect = pane.getBoundingClientRect();
  const paneMiddle = paneRect.height / 2;
  let bestId: string | null = null;
  let bestDist = Infinity;
  anchors.forEach((el) => {
    const rect = el.getBoundingClientRect();
    const top = rect.top - paneRect.top;
    const dist = Math.abs(top + rect.height / 2 - paneMiddle);
    if (dist < bestDist) {
      bestDist = dist;
      bestId = el.dataset.turnId ?? null;
    }
  });
  activeTurnId.value = bestId;

  const maxScroll = pane.scrollHeight - pane.clientHeight;
  const ratio = maxScroll > 0 ? pane.scrollTop / maxScroll : 0;
  const total = tocTotalHeight.value;
  const top = ratio * total;
  const height = pane.scrollHeight > 0 ? (pane.clientHeight / pane.scrollHeight) * total : total;
  tocViewport.value = {
    top: Math.max(0, top),
    height: Math.max(8, Math.min(height, total - top)),
  };
}

function showTooltip(text: string, event: MouseEvent): void {
  const target = event.currentTarget as HTMLElement | null;
  if (!target) return;
  tooltip.value = { visible: true, text, top: target.offsetTop };
}

function hideTooltip(): void {
  tooltip.value.visible = false;
}

const showConversationToc = computed(() =>
  !props.mobile &&
  !props.sessionLoading &&
  conversationTocItems.value.length > 1,
);

// The first pending question (if any)
const pendingQuestion = computed<UIQuestion | undefined>(() =>
  props.questions && props.questions.length > 0 ? props.questions[0] : undefined,
);

// The first pending approval (if any). Rendered in the SAME bottom-dock slot as
// the question (replacing the composer) so both "agent is blocked on you"
// prompts live in one consistent place instead of approvals scrolling away at
// the end of the transcript while questions stay pinned.
const pendingApproval = computed(() =>
  props.approvals && props.approvals.length > 0 ? props.approvals[0] : undefined,
);

// ---------------------------------------------------------------------------
// Auto-scroll: "following" state machine + "new messages" pill
// ---------------------------------------------------------------------------

const panesRef = ref<HTMLElement | null>(null);
const dockRef = ref<HTMLElement | null>(null);
const panesScrollbarWidth = ref(0);
const chatDockStyle = computed(() => ({
  '--panes-scrollbar-width': `${panesScrollbarWidth.value}px`,
}));
type ComposerHandle = { loadForEdit: (value: string) => void };
type RefArg = Element | (ComponentPublicInstance & Partial<ComposerHandle>) | null;

function toHtmlEl(el: RefArg): HTMLElement | null {
  if (el instanceof HTMLElement) return el;
  if (el && '$el' in el && el.$el instanceof HTMLElement) return el.$el;
  return null;
}

function updatePanesScrollbarWidth(): void {
  const el = panesRef.value;
  panesScrollbarWidth.value = el ? Math.max(0, el.offsetWidth - el.clientWidth) : 0;
}

function bindChatPane(el: RefArg): void {
  const node = toHtmlEl(el);
  panesRef.value = node;
  if (node) rebindScrollObservers();
}

function bindChatDock(el: RefArg): void {
  const node = toHtmlEl(el);
  dockRef.value = node ?? null;
  if (el && 'loadForEdit' in el && typeof el.loadForEdit === 'function') {
    dockedComposerRef.value = { loadForEdit: el.loadForEdit.bind(el) };
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
  updateTocViewport();
}

function scrollToBottom(smooth = false): void {
  const el = panesRef.value;
  if (!el) return;
  if (smooth && typeof el.scrollTo === 'function') {
    lastSmoothScroll = performance.now();
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  } else {
    el.scrollTop = el.scrollHeight;
  }
  lastScrollTop = el.scrollTop;
  following.value = true;
  showPill.value = false;
}

function attrEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
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

const scrollKey = computed(() => {
  const approvalIds = (props.approvals ?? []).map((a) => a.approvalId).join(',');
  const t = props.turns;
  if (t.length === 0) return `0|${approvalIds}`;
  const last = t.at(-1)!;
  const thinkingLen = last.thinking?.length ?? 0;
  const toolsLen =
    last.tools?.reduce(
      (n, tool) => n + tool.name.length + (tool.arg?.length ?? 0) + (tool.output?.join('').length ?? 0),
      0,
    ) ?? 0;
  return `${t.length}:${last.text.length}:${thinkingLen}:${toolsLen}|${approvalIds}`;
});

watch(scrollKey, async () => {
  await nextTick();
  if (following.value || hasUserActionFollowLock()) scrollToBottom(false);
  else showPill.value = true;
  updateTocViewport();
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

watch(
  () => props.fileReloadKey,
  async () => {
    following.value = true;
    lastScrollTop = 0;
    await nextTick();
    scheduleStableFollow();
    updateTocViewport();
  },
);

watch(
  () => props.sessionLoading,
  async (loading, was) => {
    if (loading || !was) return;
    following.value = true;
    await nextTick();
    scheduleStableFollow();
    updateTocViewport();
  },
);

watch(
  () => props.running,
  async (now, was) => {
    if (now || !was) return;
    if (!following.value && !hasUserActionFollowLock()) return;
    await nextTick();
    scheduleStableFollow(48);
    updateTocViewport();
  },
);

function followAfterUserAction(): void {
  following.value = true;
  showPill.value = false;
  userActionFollowUntil = Date.now() + USER_ACTION_FOLLOW_LOCK_MS;
  void nextTick(() => {
    scrollToBottom(false);
    scheduleStableFollow(16);
  });
}

function handleComposerSubmit(payload: { text: string; attachments: { fileId: string; kind: 'image' | 'video' }[] }): void {
  followAfterUserAction();
  emit('submit', payload);
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

function scheduleFollow(allowPill: boolean): void {
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
    updateTocViewport();
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

defineExpose({ loadComposerForEdit });
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

    <!-- Beta conversation outline: right edge, proportional bubbles, viewport indicator, hover tooltip. -->
    <nav
      v-if="showConversationToc && betaToc"
      class="conversation-toc"
      :aria-label="t('conversation.toc')"
    >
      <div class="toc-track">
        <button
          v-for="(item, index) in conversationTocItems"
          :key="item.id"
          type="button"
          class="toc-bubble"
          :class="[item.role, { active: activeTurnId === item.id }]"
          :style="{ height: tocMetrics[index]?.height + 'px' }"
          :aria-label="`#${item.no} ${item.title}`"
          @mouseenter="(e: MouseEvent) => showTooltip(item.title, e)"
          @mouseleave="hideTooltip"
          @click="scrollToTurn(item.id)"
        >
          <span class="toc-no">{{ item.no }}</span>
        </button>
        <div
          v-if="tocViewport"
          class="toc-viewport"
          :style="{ top: tocViewport.top + 'px', height: tocViewport.height + 'px' }"
        />
      </div>
      <Transition name="toc-tip">
        <div
          v-show="tooltip.visible"
          class="toc-tooltip"
          :style="{ top: tooltip.top + 'px' }"
        >
          {{ tooltip.text }}
        </div>
      </Transition>
    </nav>

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
              <div v-if="(workspaces?.length ?? 0) > 0" class="ws-pick">
                <button type="button" class="ws-pick-btn" :title="t('conversation.switchWorkspace')" @click.stop="wsPickOpen = !wsPickOpen">
                  <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
                    <path d="M1 3.5V2.5A1 1 0 0 1 2 1.5h3.5l1.3 2h5.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"/>
                    <path d="M1 5.5h12"/>
                  </svg>
                  <span class="ws-pick-name">{{ activeWorkspaceLabel }}</span>
                  <svg class="ws-pick-chev" :class="{ open: wsPickOpen }" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="4,6 8,10 12,6" />
                  </svg>
                </button>
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
                    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
                      <path d="M8 3v10M3 8h10"/>
                    </svg>
                    <span>{{ t('conversation.addWorkspace') }}</span>
                  </button>
                </div>
              </div>
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
              @focus-swarm="focusSwarm"
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
              :bubble="bubble"
              :mobile="mobile"
              :running="running"
              :sending="sending"
              :fast-moon="fastMoon"
              :session-loading="sessionLoading"
              :compaction="compaction"
              @open-file="emit('openFile', $event)"
              @open-media="emit('openMedia', $event)"
              @copy-conversation-copied="handleCopyConversationCopied"
              @open-thinking="emit('openThinking', $event)"
              @open-compaction="emit('openCompaction', $event)"
              @open-agent="emit('openAgent', $event)"
              @edit-message="emit('editMessage', $event)"
            />
            <div v-if="activeSwarms.length > 0" class="swarm-stack">
              <SwarmCard v-for="group in activeSwarms" :key="group.id" :group="group" />
            </div>
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
        :pending-approval="pendingApproval"
        :mobile="mobile"
        @toggle-dock-panel="toggleDockPanel($event)"
        @close-dock-panel="closeDockPanel()"
        @answer="handleQuestionAnswer"
        @dismiss="emit('dismiss', $event)"
        @approval="handleApproval"
        @cancel-task="emit('cancelTask', $event)"
        @control-goal="emit('controlGoal', $event)"
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
          @focus-goal="focusGoal"
          @focus-swarm="focusSwarm"
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
        :aria-label="t('conversation.jumpToLatestAria')"
        @click="scrollToBottom(true)"
      >
        <svg
          class="pill-chevron"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="4,6 8,10 12,6" />
        </svg>
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
.conversation-toc {
  position: absolute;
  z-index: 8;
  display: flex;
  flex-direction: column;
  padding: 0;
  top: 86px;
  bottom: auto;
  left: calc(50% + (var(--read-max) / 2) + 8px);
  width: 46px;
  max-height: calc(100% - 86px - 130px);
  opacity: 0.45;
  transition: opacity 0.18s ease;
}
.conversation-toc:hover {
  opacity: 1;
}
.toc-track {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  padding: 6px 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
  max-height: 100%;
  position: relative;
}
.toc-track::-webkit-scrollbar {
  display: none;
}
.toc-bubble {
  appearance: none;
  position: relative;
  flex-shrink: 0;
  border: 0;
  padding: 0;
  width: 34px;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  opacity: 0.85;
  transition: opacity 0.14s ease, transform 0.14s ease, box-shadow 0.14s ease;
}
.toc-bubble.active {
  opacity: 1;
}
.toc-bubble:hover,
.toc-bubble:focus-visible {
  opacity: 1;
  transform: translateX(2px) scale(1.05);
  outline: none;
}
.toc-bubble.user {
  background: var(--blue);
  box-shadow: none;
}
.toc-bubble.assistant {
  background: var(--panel2);
  box-shadow: inset 0 0 0 1px var(--line);
}
.toc-bubble.compaction {
  height: 10px;
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--faint);
  border-radius: 999px;
}
.toc-bubble.active::after {
  content: '';
  position: absolute;
  inset: -2px;
  border: 2px solid var(--blue);
  border-radius: 10px;
  pointer-events: none;
  opacity: 0.35;
}
.toc-no {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.toc-viewport {
  position: absolute;
  left: 0;
  right: 0;
  background: color-mix(in srgb, var(--blue) 10%, transparent);
  pointer-events: none;
  border-radius: 4px;
  z-index: 0;
}
.toc-tooltip {
  position: absolute;
  right: calc(100% + 8px);
  top: 0;
  z-index: 20;
  max-width: 240px;
  padding: 6px 10px;
  background: var(--bg);
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 8px;
  font-size: var(--ui-font-size-xs);
  line-height: 1.45;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
}
.toc-tooltip::before {
  content: '';
  position: absolute;
  left: auto;
  right: -5px;
  top: 10px;
  border-width: 5px 0 5px 5px;
  border-style: solid;
  border-color: transparent transparent transparent var(--bg);
}
.toc-tip-enter-active,
.toc-tip-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.toc-tip-enter-from,
.toc-tip-leave-to {
  opacity: 0;
  transform: translateX(4px);
}
@container (max-width: 920px) {
  .conversation-toc {
    display: none;
  }
}
.swarm-stack {
  padding: 0 18px 16px;
}
.content-wrap.align-mobile .swarm-stack {
  padding: 0 14px 18px;
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
  color: var(--ink);
  font-family: var(--sans);
}
.empty-hint-title {
  font-size: calc(var(--ui-font-size) + 16px);
  font-weight: 600;
}
.empty-hint-text {
  display: inline-block;
  font-size: calc(var(--ui-font-size) + 2px);
  color: var(--dim);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.ws-pick-btn:hover { border-color: var(--bd); color: var(--ink); }
.ws-pick-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ws-pick-chev { flex: none; color: var(--muted); transition: transform 0.15s; }
.ws-pick-chev.open { transform: rotate(180deg); }
.ws-pick-backdrop {
  position: fixed;
  inset: 0;
  z-index: 19;
}
.ws-pick-menu {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  top: calc(100% + 6px);
  z-index: 20;
  min-width: 220px;
  max-width: min(86vw, 340px);
  max-height: 50vh;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.14);
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
.ws-pick-item.on { background: var(--soft); }
.ws-pick-item-name { font-size: var(--ui-font-size-sm); color: var(--ink); }
.ws-pick-item.on .ws-pick-item-name { color: var(--blue2); font-weight: 600; }
.ws-pick-item-path { font-size: calc(var(--ui-font-size) - 3px); color: var(--muted); }
.ws-pick-item.ws-pick-more {
  flex-direction: row;
  justify-content: center;
  color: var(--dim);
}
.ws-pick-item.ws-pick-more:hover { color: var(--ink); }
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
.ws-pick-action:hover { background: var(--panel2); color: var(--ink); }
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
  color: var(--ink);
  font-size: var(--ui-font-size-sm);
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  z-index: 10;
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
  border-radius: 6px;
  background: var(--ink);
  color: var(--bg);
  font-size: var(--ui-font-size-sm);
  z-index: 20;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
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
</style>
