<!-- apps/kimi-web/src/components/ConversationPane.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ActivityState, ActivationBadges, ApprovalBlock, ChatTurn, ConnectionState, ConversationStatus, DiffViewLine, FilePreviewRequest, PaneKey, PermissionMode, QueuedPromptView, TaskItem, TodoView, ToolMedia, UIQuestion, WorkspaceView } from '../types';
import type { AppGoal, AppModel, AppSkill, FsEntry, QuestionResponse, ThinkingLevel } from '../api/types';
import type { SwarmGroup } from '../composables/swarmGroups';
import { usePaneLayout } from '../composables/usePaneLayout';
import type { PaneGroup, PaneLayout } from '../composables/usePaneLayout';
import type { FileItem } from './MentionMenu.vue';
import type { FileData } from './FilePreview.vue';
import TabBar from './TabBar.vue';
import ChatPane from './ChatPane.vue';
import ChatHeader from './ChatHeader.vue';
import DiffView from './DiffView.vue';
import ChangedTree from './ChangedTree.vue';
import TasksPane from './TasksPane.vue';
import TodoCard from './TodoCard.vue';
import FileTree from './FileTree.vue';
import FilePreview from './FilePreview.vue';
import Composer from './Composer.vue';
import Terminal from './Terminal.vue';
import QuestionCard from './QuestionCard.vue';
import ApprovalCard from './ApprovalCard.vue';
import SwarmCard from './SwarmCard.vue';
import GoalStrip from './GoalStrip.vue';
import ViewGroup from './ViewGroup.vue';
import SplitLayout from './SplitLayout.vue';
import { getVisibleWorkspaces } from '../lib/workspacePicker';

const props = defineProps<{
  turns: ChatTurn[];
  sessionId?: string;
  approvals?: { approvalId: string; block: ApprovalBlock; agentName?: string }[];
  changes?: { path: string; status: string }[];
  gitInfo?: { branch: string; ahead: number; behind: number } | null;
  // ~/diff line-by-line view
  fileDiff?: DiffViewLine[];
  selectedDiffPath?: string | null;
  fileDiffLoading?: boolean;
  loadFileDiff?: (path: string) => Promise<void> | void;
  clearFileDiff?: () => void;
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
  connection?: ConnectionState;
  activity?: ActivityState;
  sending?: boolean;
  fastMoon?: boolean;
  // File browser props
  loadDir?: (path: string) => Promise<FsEntry[]>;
  readFile?: (path: string) => Promise<FileData | null>;
  changesByPath?: Record<string, string>;
  fileReloadKey?: string | number;
  /** Mobile shell: compact chrome + give the TabBar bigger taps. */
  mobile?: boolean;
  /** Bubble themes (Modern/Kimi): render chat bubbles at all widths (desktop included). */
  modern?: boolean;
  /** True while switching sessions and the turns array is not yet loaded. */
  sessionLoading?: boolean;
  /** Live compaction state of the active session (non-null while running). */
  compaction?: { status: 'running' } | null;
  /** Available models for the quick-switch dropdown in the composer toolbar. */
  models?: AppModel[];
  /** Session skills shown in the composer `/` menu. */
  skills?: AppSkill[];
  /** Workspace name shown in the empty-session hint above the centred composer. */
  workspaceName?: string;
  /** Absolute workspace root path shown by the Open menu. */
  workspaceRoot?: string;
  /** Installed app IDs from the daemon; passed through to the Open menu. */
  availableOpenInApps?: string[];
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
  // ---- Global preview pane (file/media opened from chat links) ------------
  // Owned by App; rendered here as a split pane (a peer of chat/files) so the
  // preview lives at the same level as the other views, not in a separate panel.
  previewFile?: FileData | null;
  previewLoading?: boolean;
  previewError?: string | null;
  previewLine?: number;
  previewDownloadUrl?: string | null;
  previewExternalActions?: boolean;
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
  openBtw: [];
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
  /** Edit + resend the last user message (App undoes, then refills composer). */
  editMessage: [text: string];
  /** Preview pane: close it (App clears the preview state). */
  closePreview: [];
  /** Preview pane: open the previewed file in the external editor. */
  openPreviewExternal: [];
  /** Preview pane: reveal the previewed file in the OS file manager. */
  revealPreview: [];
  /** Empty-composer workspace picker: start a new conversation elsewhere. */
  selectWorkspace: [workspaceId: string];
  /** Empty-composer workspace picker: create a new workspace. */
  addWorkspace: [];
  /** Chat header: open the workspace in an external application. */
  openInApp: [appId: string];
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

// expose a way for App.vue to imperatively switch to tasks tab
const active = ref<PaneKey>('chat');
const paneLayout = usePaneLayout();
const chatPaneRef = ref<InstanceType<typeof ChatPane> | null>(null);
const emptyComposerRef = ref<{ loadForEdit: (v: string) => void } | null>(null);
const dockedComposerRef = ref<{ loadForEdit: (v: string) => void } | null>(null);
const copyConversationCopied = ref(false);
const goalExpandSignal = ref(0);
let copyConversationCopiedTimer: ReturnType<typeof setTimeout> | null = null;

/** Called by App.vue via command routing to switch to a specific tab */
function switchTab(tab: PaneKey): void {
  active.value = tab;
  const root = paneLayout.layout.value;
  const groupId = root.type === 'group' ? root.id : firstGroupId(root);
  if (groupId) paneLayout.setActive(groupId, tab);
}

/** Load text into whichever composer is currently mounted (docked vs the
    empty-session composer). Used by App for "edit & resend the last message". */
function loadComposerForEdit(value: string): void {
  (dockedComposerRef.value ?? emptyComposerRef.value)?.loadForEdit(value);
}

/** Open (or focus) the preview pane — App calls this when a file/media preview
    is requested, so the preview shows as a split pane at the chat/files level. */
function openPreviewPane(): void {
  paneLayout.openPreview();
}

/** Close the preview pane and tell App to clear the preview state. */
function closePreviewPane(): void {
  paneLayout.closePreview();
  emit('closePreview');
}

// When App clears the preview (e.g. on a session switch), drop the now-empty
// preview pane. Watcher batching means the transient null state while a preview
// is opening (loading already true by then) never triggers this.
watch(
  () => [props.previewFile, props.previewLoading, props.previewError] as const,
  ([file, loading, error]) => {
    if (!file && !loading && !error) paneLayout.closePreview();
  },
);
defineExpose({ switchTab, loadComposerForEdit, openPreviewPane });

function firstGroupId(node: PaneLayout): string | undefined {
  if (node.type === 'group') return node.id;
  return node.children.map(firstGroupId).find((id): id is string => id !== undefined);
}

function selectGroupPane(group: PaneGroup, pane: PaneKey): void {
  active.value = pane;
  paneLayout.setActive(group.id, pane);
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
  active.value = 'chat';
  void nextTick(() => {
    const first = panesRef.value?.querySelector<HTMLElement>('.swarm-card');
    first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

// The TabBar is hidden for an empty session (the centred quick-start composer
// takes the whole pane) — if the user was parked on tasks/todo/files when the
// session emptied out, they'd be trapped with no tabs AND no composer. Snap
// back to chat whenever the tab chrome disappears.
watch(
  () => props.turns.length === 0 && !props.sessionLoading,
  (chromeHidden) => {
    if (chromeHidden && active.value !== 'chat') active.value = 'chat';
  },
);

// Bubble chat layout: always on mobile, and on desktop under Modern/Kimi.
const bubble = computed(() => props.mobile === true || props.modern === true);

const bashTasks = computed(() => props.tasks.filter((t) => t.kind !== 'subagent'));
const subagentTasks = computed(() => props.tasks.filter((t) => t.kind === 'subagent'));
const bashRunning = computed(() => bashTasks.value.filter((t) => t.state === 'run').length);
const subagentRunning = computed(() => subagentTasks.value.filter((t) => t.state === 'run').length);
const todoDoneCount = computed(() => (props.todos ?? []).filter((td) => td.status === 'done').length);
const hasDockWork = computed(() => props.tasks.length > 0 || (props.todos?.length ?? 0) > 0);
const dockPanel = ref<'bash' | 'subagent' | 'todos' | null>(null);
const changesCount = computed(() => (props.gitInfo ? props.changes?.length ?? 0 : 0));
const dockVisible = computed(() => active.value === 'chat' && !(props.turns.length === 0 && !props.sessionLoading));

function toggleDockPanel(panel: 'bash' | 'subagent' | 'todos'): void {
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

// Desktop renders chat per split-group (`group.active`), not via the top-level
// `active` ref (which only tracks the mobile single-pane tab). Drive the TOC off
// "is a chat pane actually visible in the layout" so splitting another group to
// files/terminal doesn't wrongly hide the whole outline.
function layoutHasChatGroup(node: PaneLayout): boolean {
  return node.type === 'group'
    ? node.active === 'chat'
    : node.children.some(layoutHasChatGroup);
}

const showConversationToc = computed(() =>
  !props.mobile &&
  layoutHasChatGroup(paneLayout.layout.value) &&
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
// File browser state (local to this pane, lives here so re-mounting the pane
// doesn't reset it unless the session changes)
// ---------------------------------------------------------------------------

const selectedFile = ref<FileData | null>(null);
const previewLoading = ref(false);
// Mobile drill-down: false = showing the tree, true = showing the preview with a
// Back affordance. Desktop ignores this (the split shows both at once).
const filesShowPreview = ref(false);

async function handleFileSelect(entry: FsEntry): Promise<void> {
  if (!props.readFile) return;
  // On mobile, drill into the preview view immediately (even while loading).
  if (props.mobile) filesShowPreview.value = true;
  previewLoading.value = true;
  selectedFile.value = null;
  try {
    const result = await props.readFile(entry.path);
    if (result) {
      selectedFile.value = result;
    }
  } finally {
    previewLoading.value = false;
  }
}

// ---------------------------------------------------------------------------
// Merged ~/files tab: a navigator (left/full-width) with a Changed|All toggle,
// and an adaptive content pane (right/drill-down) — a changed file shows its
// line-by-line diff, an unchanged file shows its content preview.
// ---------------------------------------------------------------------------
const changedView = ref<'changed' | 'all'>('changed');

// Non-git workspace (gitInfo is null): there is no Changed view to offer —
// the Changed|All toggle is hidden and the full file tree shows directly.
const hasGit = computed(() => (props.gitInfo ?? null) !== null);
const filesView = computed<'changed' | 'all'>(() => (hasGit.value ? changedView.value : 'all'));

// The "Changed" navigator can show a flat list or a directory tree (persisted).
const CHANGED_LAYOUT_KEY = 'kimi-web.changed-layout';
function loadChangedLayout(): 'list' | 'tree' {
  try {
    const v = localStorage.getItem(CHANGED_LAYOUT_KEY);
    if (v === 'tree' || v === 'list') return v;
  } catch {
    // ignore
  }
  return 'tree';
}
const changedLayout = ref<'list' | 'tree'>(loadChangedLayout());
function toggleChangedLayout(): void {
  changedLayout.value = changedLayout.value === 'tree' ? 'list' : 'tree';
  try {
    localStorage.setItem(CHANGED_LAYOUT_KEY, changedLayout.value);
  } catch {
    // ignore
  }
}

function isChanged(path: string): boolean {
  return props.changesByPath?.[path] !== undefined;
}

/** Pick a changed file → show its diff. Clears any file-content preview first. */
function pickChanged(path: string): void {
  selectedFile.value = null;
  if (props.mobile) filesShowPreview.value = true;
  void props.loadFileDiff?.(path);
}

/** Pick a tree entry → diff if it's a changed file, else its content preview. */
async function pickEntry(entry: FsEntry): Promise<void> {
  if (entry.kind === 'directory') return;
  if (isChanged(entry.path)) {
    pickChanged(entry.path);
    return;
  }
  props.clearFileDiff?.();
  await handleFileSelect(entry);
}

/** Mobile: return from the content pane back to the navigator; clear selections. */
function handleFilesBack(): void {
  filesShowPreview.value = false;
  props.clearFileDiff?.();
  selectedFile.value = null;
}

// No-op loadDir fallback so FileTree never receives undefined
function defaultLoadDir(): Promise<FsEntry[]> {
  return Promise.resolve([]);
}

// ---------------------------------------------------------------------------
// Auto-scroll: "following" state machine + "new messages" pill (chat tab only)
//
// `following` is an INTENT flag, not a position snapshot. While true, every
// content/layout change re-pins the view to the bottom. It only turns off
// when the USER scrolls up out of the bottom zone — our own scrolls only ever
// move down, so an upward scrollTop move is always user intent. It turns back
// on when the user returns to the bottom zone, clicks the pill, sends a
// prompt, answers a question, or switches session/tab.
//
// The previous design gated on an `atBottom` snapshot updated by scroll
// events, which broke under streaming: the scroll event fired by our own
// scrollToBottom could observe a view that had ALREADY grown past the
// threshold and flip the gate off mid-stream (thinking/tool phases), leaving
// the view stuck above the newest content.
// ---------------------------------------------------------------------------

const panesRef = ref<HTMLElement | null>(null);
const dockRef = ref<HTMLElement | null>(null);
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
// Timestamp of the last SMOOTH programmatic scroll (the only async multi-event
// path). The synchronous streaming scrolls are intentionally NOT recorded here.
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

  // Treat scroll events within 100 ms of a SMOOTH programmatic scroll as
  // non-user; just sync lastScrollTop so the next real user scroll compares
  // correctly. This window only covers the async, multi-event smooth path (the
  // pill). The streaming follow uses the synchronous scrollTop setter, which
  // updates lastScrollTop immediately — its async echo event lands at
  // top === lastScrollTop and is a harmless no-op. Gating streaming on this
  // window was the bug: during the thinking phase the view re-pins every
  // ~120 ms, so a user's upward scroll almost always fell inside a fresh window
  // and was swallowed, yanking them back to the bottom.
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
    // ANY upward move is user intent — stop following immediately, even inside
    // the bottom zone. Content that mutates on a fast cadence (e.g. the moon
    // spinner re-renders every 120ms) re-pins on every change; if upward moves
    // inside the zone didn't break the follow, each wheel tick (~20-60px, less
    // than the 80px zone) would be yanked back before the user could escape.
    // `dist > 1` exempts the browser CLAMPING scrollTop when content shrinks
    // (e.g. a turn auto-folding) — that lands exactly at the bottom and is not
    // a user scroll.
    following.value = false;
  } else if (dist <= BOTTOM_THRESHOLD && top > lastScrollTop + 1) {
    // STRICTLY downward arrival in the bottom zone → follow again. Equal
    // positions must not re-arm the follow: browsers re-fire scroll events at
    // an unchanged position (coalesced/synthetic scrolls), and treating those
    // as "downward" would re-enable the follow right after the user scrolled
    // up inside the zone — the next content mutation then yanks them back to
    // the bottom. Our own scrollToBottom sets `following` itself, so it does
    // not depend on this branch.
    following.value = true;
    showPill.value = false;
  }
  lastScrollTop = top;
  updateTocViewport();
}

function scrollToBottom(smooth = false): void {
  const el = panesRef.value;
  if (!el) return;
  // Use the synchronous scrollTop setter for instant scrolling to avoid race
  // conditions where a delayed scroll event from el.scrollTo() sees a stale
  // lastScrollTop and incorrectly treats the scroll as upward user intent.
  // Only the smooth path emits delayed events, so only it records the window.
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

/**
 * Re-pin until the tail layout is stable for a few consecutive frames. A page
 * refresh can rebuild the transcript before the working moon, copy footer,
 * markdown images, or code highlighting have their final height; this waits for
 * those late tail elements instead of trusting one early scroll.
 */
function scheduleStableFollow(maxFrames = 36): void {
  if (active.value !== 'chat') return;
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
    if (active.value !== 'chat') return;
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

// Scroll key: reacts to new turns AND to ANY streaming content on the last turn —
// thinking deltas, text deltas, and tool output all grow the view, so all must
// trigger the follow-to-bottom (previously only text was tracked, so the view
// stopped following during the thinking phase).
const scrollKey = computed(() => {
  if (active.value !== 'chat') return '';
  // Include approvals so the view scrolls when a new approval card appears
  // (e.g. a tool call waiting for user confirmation at the end of the stream).
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

// Vue-tracked content changes (redundant with the observers below, kept as a
// cheap safety net + the pill trigger for data-driven updates).
watch(scrollKey, async () => {
  if (active.value !== 'chat') return;
  await nextTick();
  if (following.value || hasUserActionFollowLock()) scrollToBottom(false);
  else showPill.value = true;
  updateTocViewport();
});

// When switching to the chat tab, scroll to bottom immediately. Leaving the
// files tab resets the mobile drill-down back to the tree so re-entering it
// never lands on a stale preview.
watch(active, async (tab) => {
  if (tab !== 'files') filesShowPreview.value = false;
  if (tab !== 'chat') return;
  following.value = true;
  await nextTick();
  ensureDockObserved();
  scheduleStableFollow();
  updateTocViewport();
});

watch(dockRef, () => {
  ensureDockObserved();
});

// New session (reload key changes): reset the mobile files drill-down + clear
// any previously-opened preview, and land at the bottom of the newly-selected
// session. `following` stays on afterwards, so the markdown/code-highlighting
// that keeps growing the content after the load is followed automatically.
watch(
  () => props.fileReloadKey,
  async () => {
    filesShowPreview.value = false;
    selectedFile.value = null;
    following.value = true;
    // Reset the scroll tracking baseline so the browser clamping scroll event
    // that fires when the new (usually shorter) session renders is not mistaken
    // for a user upward scroll, which would flip following back off before the
    // stable-follow loop can pin the view to the bottom.
    lastScrollTop = 0;
    await nextTick();
    scheduleStableFollow();
    updateTocViewport();
  },
);

// Re-pin when a freshly-opened session finishes its async message load (the
// fileReloadKey watch above fires BEFORE the REST load completes).
watch(
  () => props.sessionLoading,
  async (loading, was) => {
    if (loading || !was) return; // only on the load-finished (true -> false) edge
    if (active.value !== 'chat') return;
    following.value = true;
    await nextTick();
    scheduleStableFollow();
    updateTocViewport();
  },
);

// Re-pin when a turn finishes (running true -> false). The end of a stream is the
// one moment the content keeps changing height AFTER the last delta the observers
// saw: the moon/working footer is removed, the streamed Markdown re-renders in
// its final (non-streaming) form, late syntax highlighting reflows code blocks,
// and the copy-button footer appears. Each can leave the view a hair short of the
// bottom. Re-pin across the next few frames + once more after highlighting likely
// settled, but only while still following (never yank a user who scrolled up).
watch(
  () => props.running,
  async (now, was) => {
    if (now || !was) return; // only on the run-finished edge
    if (active.value !== 'chat') return;
    if (!following.value && !hasUserActionFollowLock()) return;
    await nextTick();
    scheduleStableFollow(48);
    updateTocViewport();
  },
);

// The user sent a prompt (or answered an agent question): always jump to the
// bottom, even if they were scrolled up reading history.
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

// ---------------------------------------------------------------------------
// Follow triggers.
// - MutationObserver on the scroller subtree: streaming text, thinking deltas,
//   tool output, markdown, new cards. May raise the pill when not following.
// - ResizeObservers: (a) the bottom dock — QuestionCard replacing the
//   Composer, the queue strip or attachment chips growing the dock all shrink
//   the scroll viewport WITHOUT any scroll/mutation event, which used to
//   leave the newest content hidden behind the dock; (b) the scroller itself
//   (window resizes); (c) the content column (image loads etc. that change
//   size without DOM mutations). Resizes re-pin but never raise the pill —
//   nothing new arrived.
// ---------------------------------------------------------------------------
let contentObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let observedContent: Element | null = null;
let observedDock: HTMLElement | null = null;
let scrollRaf = 0;
let pillEligible = false;

function scheduleFollow(allowPill: boolean): void {
  if (active.value !== 'chat') return;
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

/** Keep the ResizeObserver attached to the scroller's current content column
    (it is destroyed/recreated on tab switches and session changes). */
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

function onContentMutated(): void {
  ensureContentObserved();
  scheduleFollow(true);
}

// Background tabs freeze rAF, so a stream that ran while the tab was hidden
// may leave the view above the bottom; re-pin when the tab becomes visible.
function onVisibilityChange(): void {
  if (typeof document === 'undefined') return;
  if (document.visibilityState === 'visible' && following.value && active.value === 'chat') {
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

// Single entry point for manual interrupt so the Escape key and the composer's
// stop button give the SAME feedback (the toast). Previously only Escape showed
// it, so clicking stop aborted silently.
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
  // Initial scroll to bottom on first load.
  nextTick(() => {
    scheduleStableFollow(48);
    updateTocViewport();
    if (panesRef.value && typeof MutationObserver === 'function') {
      contentObserver = new MutationObserver(onContentMutated);
      contentObserver.observe(panesRef.value, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => scheduleFollow(false));
      if (panesRef.value) resizeObserver.observe(panesRef.value);
      ensureDockObserved();
      ensureContentObserved();
    }
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
      :available-open-in-apps="availableOpenInApps"
      :session-title="sessionTitle"
      :branch="gitInfo?.branch"
      :ahead="gitInfo?.ahead"
      :behind="gitInfo?.behind"
      :changes-count="changesCount"
      :git-diff-stats="gitDiffStats"
      :is-git-repo="!!gitInfo"
      :pr="pr"
      :copied="copyConversationCopied"
      @open-in-app="(app) => emit('openInApp', app)"
      @copy-all="chatPaneRef?.copyConversation()"
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

    <TabBar
      v-if="mobile && !(turns.length === 0 && !sessionLoading)"
      :active="active"
      :changes-count="changesCount"
      :mobile="mobile"
      @select="active = $event"
    />

    <SplitLayout
      v-if="!mobile && !(turns.length === 0 && !sessionLoading)"
      class="layout-root"
      :layout="paneLayout.layout.value"
      @resize="paneLayout.resize"
    >
      <template #group="{ group }">
        <ViewGroup
          :active="group.active"
          :changes-count="changesCount"
          :can-close="paneLayout.layout.value.type !== 'group'"
          :has-preview="group.views.includes('preview')"
          @select="selectGroupPane(group, $event)"
          @split="paneLayout.split(group.id, $event)"
          @close="group.active === 'preview' ? closePreviewPane() : paneLayout.close(group.id)"
        >
          <div
            :ref="group.active === 'chat' ? 'panesRef' : undefined"
            class="panes group-panes"
            :class="{ 'files-layout': group.active === 'files', 'terminal-layout': group.active === 'terminal' }"
            @click="closeDockPanel"
            @scroll.passive="group.active === 'chat' ? onPanesScroll() : undefined"
          >
            <div v-if="group.active === 'chat'" class="content-wrap" :class="[mobile ? 'align-mobile' : 'align-center']">
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
                @open-agent="emit('openAgent', $event)"
                @open-compaction="emit('openCompaction', $event)"
                @edit-message="emit('editMessage', $event)"
              />
              <div v-if="activeSwarms.length > 0" class="swarm-stack">
                <SwarmCard v-for="groupItem in activeSwarms" :key="groupItem.id" :group="groupItem" />
              </div>
            </div>
            <TasksPane
              v-else-if="group.active === 'tasks'"
              :tasks="tasks"
              @cancel="emit('cancelTask', $event)"
            />
            <TodoCard
              v-else-if="group.active === 'todo'"
              :todos="todos ?? []"
              inline
            />
            <Terminal
              v-else-if="group.active === 'terminal' && sessionId"
              :session-id="sessionId"
            />
            <!-- Preview pane: a file/media preview opened from a chat link, shown
                 here as a peer of chat/files instead of a separate side panel. -->
            <FilePreview
              v-else-if="group.active === 'preview'"
              :file="previewFile ?? null"
              :loading="previewLoading ?? false"
              :error="previewError ?? null"
              :line="previewLine"
              :download-url="previewDownloadUrl ?? null"
              closable
              :external-actions="previewExternalActions"
              @close="closePreviewPane"
              @open-external="emit('openPreviewExternal')"
              @reveal="emit('revealPreview')"
            />
            <template v-else-if="group.active === 'files'">
              <div v-show="!mobile || !filesShowPreview" class="files-nav">
                <div v-if="hasGit" class="nav-seg">
                  <div class="seg-group" role="group" :aria-label="t('fileTree.segLabel')">
                    <button type="button" class="seg-btn" :class="{ on: changedView === 'changed' }" :aria-pressed="changedView === 'changed'" @click="changedView = 'changed'">
                      {{ t('fileTree.changed') }}
                      <span v-if="(changesCount ?? 0) > 0" class="seg-n">{{ changesCount }}</span>
                    </button>
                    <button type="button" class="seg-btn" :class="{ on: changedView === 'all' }" :aria-pressed="changedView === 'all'" @click="changedView = 'all'">{{ t('fileTree.all') }}</button>
                  </div>
                </div>
                <div v-if="filesView === 'changed'" class="nav-tools">
                  <button type="button" class="layout-toggle" :title="changedLayout === 'tree' ? t('fileTree.listView') : t('fileTree.treeView')" :aria-label="changedLayout === 'tree' ? t('fileTree.listView') : t('fileTree.treeView')" @click="toggleChangedLayout">
                    <svg v-if="changedLayout === 'list'" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 4h2M3 8h2M3 12h2"/><path d="M7.5 4l1.5 1.5L7.5 7"/><path d="M9 5.5h4M9 9.5h3.5M9 12.5h3"/></svg>
                    <svg v-else viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h10"/></svg>
                  </button>
                </div>
                <div class="files-nav-body">
                  <template v-if="filesView === 'changed'">
                    <DiffView v-if="changedLayout === 'list'" mode="list" :changes="changes ?? []" :git-info="gitInfo ?? null" @open="pickChanged" />
                    <ChangedTree v-else :changes="changes ?? []" @open="pickChanged" />
                  </template>
                  <FileTree v-else :load-dir="loadDir ?? defaultLoadDir" :changes-by-path="changesByPath ?? {}" :reload-key="fileReloadKey" @select="pickEntry" />
                </div>
              </div>
              <div v-if="!mobile" class="files-divider" aria-hidden="true"></div>
              <div v-show="!mobile || filesShowPreview" class="files-content">
                <button v-if="mobile" type="button" class="files-back" @click="handleFilesBack">
                  <span aria-hidden="true">&#8592;</span>
                  <span class="files-back-label">{{ t('fileTree.backToTree') }}</span>
                </button>
                <DiffView v-if="selectedDiffPath" mode="detail" :hide-back="true" :changes="changes ?? []" :git-info="gitInfo ?? null" :file-diff="fileDiff ?? []" :selected-diff-path="selectedDiffPath ?? null" :file-diff-loading="fileDiffLoading ?? false" />
                <FilePreview v-else-if="selectedFile || previewLoading" :file="selectedFile" :loading="previewLoading" />
                <div v-else class="files-empty">{{ filesView === 'changed' ? t('fileTree.selectChanged') : t('fileTree.selectFile') }}</div>
              </div>
            </template>
          </div>
        </ViewGroup>
      </template>
    </SplitLayout>

    <div
      v-else
      ref="panesRef"
      class="panes"
      :class="{ 'files-layout': active === 'files', 'terminal-layout': active === 'terminal' }"
      @click="closeDockPanel"
      @scroll.passive="onPanesScroll"
    >
      <!-- Chat reading column: constrained to a comfortable max width and
           aligned left or centered within the pane. -->
      <div v-if="active === 'chat'" class="content-wrap" :class="[mobile ? 'align-mobile' : 'align-center']">
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
            :skills="skills"
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
            @open-btw="emit('openBtw')"
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
            @edit-message="emit('editMessage', $event)"
          />
          <div v-if="activeSwarms.length > 0" class="swarm-stack">
            <SwarmCard v-for="group in activeSwarms" :key="group.id" :group="group" />
          </div>
        </template>
      </div>
      <TasksPane
        v-else-if="active === 'tasks'"
        :tasks="tasks"
        @cancel="emit('cancelTask', $event)"
      />

      <!-- ~/todo tab: inline todo list. -->
      <TodoCard
        v-else-if="active === 'todo'"
        :todos="todos ?? []"
        inline
      />

      <Terminal
        v-else-if="active === 'terminal' && sessionId"
        :session-id="sessionId"
      />

      <!-- Merged ~/files tab: a navigator (Changed-first list / full tree via the
           Changed|All toggle) on the left, an adaptive content pane on the right
           (diff for changed files, content preview for unchanged ones). Desktop =
           side-by-side split; mobile = single-column drill-down (v-show gates which
           half is visible; the divider only exists on desktop). -->
      <template v-else-if="active === 'files'">
        <div v-show="!mobile || !filesShowPreview" class="files-nav">
          <div v-if="hasGit" class="nav-seg">
            <div class="seg-group" role="group" :aria-label="t('fileTree.segLabel')">
              <button
                type="button"
                class="seg-btn"
                :class="{ on: changedView === 'changed' }"
                :aria-pressed="changedView === 'changed'"
                @click="changedView = 'changed'"
              >
                {{ t('fileTree.changed') }}
                <span v-if="(changesCount ?? 0) > 0" class="seg-n">{{ changesCount }}</span>
              </button>
              <button
                type="button"
                class="seg-btn"
                :class="{ on: changedView === 'all' }"
                :aria-pressed="changedView === 'all'"
                @click="changedView = 'all'"
              >{{ t('fileTree.all') }}</button>
            </div>
          </div>
          <!-- list/tree layout toggle for the Changed view -->
          <div v-if="filesView === 'changed'" class="nav-tools">
            <button
              type="button"
              class="layout-toggle"
              :title="changedLayout === 'tree' ? t('fileTree.listView') : t('fileTree.treeView')"
              :aria-label="changedLayout === 'tree' ? t('fileTree.listView') : t('fileTree.treeView')"
              @click="toggleChangedLayout"
            >
              <svg v-if="changedLayout === 'list'" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 4h2M3 8h2M3 12h2"/><path d="M7.5 4l1.5 1.5L7.5 7"/><path d="M9 5.5h4M9 9.5h3.5M9 12.5h3"/></svg>
              <svg v-else viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h10"/></svg>
            </button>
          </div>
          <div class="files-nav-body">
            <template v-if="filesView === 'changed'">
              <DiffView
                v-if="changedLayout === 'list'"
                mode="list"
                :changes="changes ?? []"
                :git-info="gitInfo ?? null"
                @open="pickChanged"
              />
              <ChangedTree v-else :changes="changes ?? []" @open="pickChanged" />
            </template>
            <FileTree
              v-else
              :load-dir="loadDir ?? defaultLoadDir"
              :changes-by-path="changesByPath ?? {}"
              :reload-key="fileReloadKey"
              @select="pickEntry"
            />
          </div>
        </div>

        <div v-if="!mobile" class="files-divider" aria-hidden="true"></div>

        <div v-show="!mobile || filesShowPreview" class="files-content">
          <button v-if="mobile" type="button" class="files-back" @click="handleFilesBack">
            <span aria-hidden="true">&#8592;</span>
            <span class="files-back-label">{{ t('fileTree.backToTree') }}</span>
          </button>
          <DiffView
            v-if="selectedDiffPath"
            mode="detail"
            :hide-back="true"
            :changes="changes ?? []"
            :git-info="gitInfo ?? null"
            :file-diff="fileDiff ?? []"
            :selected-diff-path="selectedDiffPath ?? null"
            :file-diff-loading="fileDiffLoading ?? false"
          />
          <FilePreview
            v-else-if="selectedFile || previewLoading"
            :file="selectedFile"
            :loading="previewLoading"
          />
          <div v-else class="files-empty">
            {{ filesView === 'changed' ? t('fileTree.selectChanged') : t('fileTree.selectFile') }}
          </div>
        </div>
      </template>
    </div>

    <!-- "New messages" pill — only visible on chat tab when the user has
         scrolled up and new content has arrived. -->
    <Transition name="pill">
      <button
        v-if="showPill && active === 'chat'"
        class="newmsg-pill"
        @click="scrollToBottom(true)"
        :aria-label="t('conversation.jumpToLatestAria')"
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

    <!-- Bottom dock. Capped to the chat reading column so it doesn't stretch
         edge-to-edge on wide screens. The composer/input sits on top; the status
         line is a quiet footer BELOW it (model/thinking/plan/permission left,
         ctx far right). -->
    <div v-if="dockVisible" ref="dockRef" class="dock" :class="[mobile ? 'align-mobile' : 'align-center']">
      <Transition name="dock-panel">
        <div
          v-if="dockPanel"
          class="dock-work-panel"
          @click.stop
        >
          <div class="dock-work-head">
            <span
              v-if="dockPanel === 'bash'"
              class="dock-work-tab static"
            >
              {{ t('tasks.dockBash') }} · {{ bashRunning }} {{ t('tasks.running') }}
            </span>
            <span
              v-else-if="dockPanel === 'subagent'"
              class="dock-work-tab static"
            >
              {{ t('tasks.dockSubagent') }} · {{ subagentRunning }} {{ t('tasks.running') }}
            </span>
            <span
              v-else-if="dockPanel === 'todos'"
              class="dock-work-tab static"
            >
              {{ t('tasks.dockTodos') }} · {{ todoDoneCount }}/{{ todos?.length ?? 0 }}
            </span>
            <button type="button" class="dock-work-close" :aria-label="t('tasks.closePanel')" @click="closeDockPanel">
              <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
                <path d="M2 2l8 8M10 2l-8 8" />
              </svg>
            </button>
          </div>
          <div class="dock-work-body">
            <TasksPane
              v-if="dockPanel === 'bash'"
              :tasks="bashTasks"
              @cancel="emit('cancelTask', $event)"
            />
            <TasksPane
              v-else-if="dockPanel === 'subagent'"
              :tasks="subagentTasks"
              @cancel="emit('cancelTask', $event)"
            />
            <TodoCard
              v-else
              :todos="todos ?? []"
              inline
            />
          </div>
        </div>
      </Transition>

      <GoalStrip
        v-if="goal"
        :goal="goal"
        :force-expanded="goalExpandSignal"
        @control-goal="emit('controlGoal', $event)"
      />
      <div v-if="hasDockWork" class="dock-workbar">
        <button
          v-if="bashTasks.length > 0"
          type="button"
          class="dock-work-chip"
          :class="{ on: dockPanel === 'bash' }"
          :aria-pressed="dockPanel === 'bash'"
          @click="toggleDockPanel('bash')"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <circle cx="8" cy="8" r="5.5" />
            <path d="M8 4.5V8l2.5 1.5" />
          </svg>
          <span>{{ t('tasks.dockBash') }}</span>
          <span class="dw-count">(<b>{{ bashTasks.length }}</b>)</span>
        </button>
        <button
          v-if="subagentTasks.length > 0"
          type="button"
          class="dock-work-chip"
          :class="{ on: dockPanel === 'subagent' }"
          :aria-pressed="dockPanel === 'subagent'"
          @click="toggleDockPanel('subagent')"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z" />
          </svg>
          <span>{{ t('tasks.dockSubagent') }}</span>
          <span class="dw-count">(<b>{{ subagentTasks.length }}</b>)</span>
        </button>
        <button
          v-if="(todos?.length ?? 0) > 0"
          type="button"
          class="dock-work-chip"
          :class="{ on: dockPanel === 'todos' }"
          :aria-pressed="dockPanel === 'todos'"
          @click="toggleDockPanel('todos')"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M3 4.5l1.5 1.5L7 3.5" />
            <path d="M8.5 5h4" />
            <path d="M3 11l1.5 1.5L7 10" />
            <path d="M8.5 11.5h4" />
          </svg>
          <span>{{ t('tasks.dockTodos') }}</span>
          <span class="dw-count">(<b>{{ todoDoneCount }}/{{ todos?.length ?? 0 }}</b>)</span>
        </button>
      </div>
      <!-- A pending question or approval replaces the Composer here — both are
           the agent blocking on the user, so they share this docked slot. A
           question takes priority (it is a direct ask); the approval falls back
           to the composer once resolved. -->
      <QuestionCard
        v-if="pendingQuestion"
        :key="pendingQuestion.questionId"
        :question="pendingQuestion"
        @answer="handleQuestionAnswer"
        @dismiss="(qid) => emit('dismiss', qid)"
      />
      <ApprovalCard
        v-else-if="pendingApproval"
        :key="pendingApproval.approvalId"
        class="dock-approval"
        :block="pendingApproval.block"
        :agent-name="pendingApproval.agentName"
        @decide="(response) => emit('approval', pendingApproval!.approvalId, response)"
      />
      <Composer
        ref="dockedComposerRef"
        v-else
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
        :skills="skills"
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
        @open-btw="emit('openBtw')"
        @create-goal="emit('createGoal', $event)"
        @control-goal="emit('controlGoal', $event)"
        @focus-goal="focusGoal"
        @focus-swarm="focusSwarm"
        @compact="emit('compact')"
        @pick-model="emit('pickModel')"
        @select-model="emit('selectModel', $event)"
      />
    </div>

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
}

.panes {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* The pane manages its own follow-to-bottom; native scroll anchoring would
     otherwise pin content BELOW an expanding fold and make it open upward. */
  overflow-anchor: none;
  /* Reserve the scrollbar gutter permanently. The composer growing (e.g. a
     multi-line paste) shrinks this viewport and can flip the scrollbar
     in/out of existence — without a stable gutter every flip shifts the
     centered reading column sideways. */
  scrollbar-gutter: stable;
}
.layout-root {
  flex: 1;
  min-height: 0;
}
.group-panes {
  height: 100%;
}

/* Chat reading column max-width + alignment. The max-width applies in both
   modes; align-left hugs the left gutter, align-center centers in the pane. */
.content-wrap {
  max-width: var(--read-max);
  /* Fill the scroll viewport so an empty conversation can vertically center its
     hint (ChatPane grows via flex:1). With messages it grows past 100% and the
     .panes scrolls as usual. */
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
  top: 74px;
  bottom: auto;
  left: calc(50% + (var(--read-max) / 2) + 8px);
  width: 46px;
  max-height: calc(100% - 74px - 130px);
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
  inset: -2px -4px -2px -2px;
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
  background: var(--ink);
  color: #fff;
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
  border-color: transparent transparent transparent var(--ink);
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
@media (max-width: 1180px) {
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
  /* Long workspace names must not wrap into a multi-line hint. */
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

/* Larger textarea in the centred empty-session composer */
:deep(.empty-composer .ph) {
  min-height: 120px;
}

/* Mobile empty session: a 120px textarea floating mid-screen jumps around
   when the soft keyboard opens. Keep the input compact and the hint modest. */
@media (max-width: 640px) {
  :deep(.empty-composer .ph) {
    min-height: 44px;
  }
  .empty-hint {
    font-size: calc(var(--ui-font-size) + 3px);
  }
}

/* Bottom dock (status line + composer): capped to the same reading column as
   the chat and aligned the same way, so it doesn't stretch the full pane width
   on wide screens. Full-width on mobile. */
.dock {
  flex: none;
  display: flex;
  flex-direction: column;
  position: relative;
  width: 100%;
  max-width: var(--read-max);
}
.dock.align-center { margin-left: auto; margin-right: auto; }
.dock.align-left { margin-left: 0; margin-right: auto; }
.dock.align-mobile { max-width: none; }
@media (max-width: 640px) {
  .dock.align-mobile {
    box-sizing: border-box;
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
  }
}

.dock-workbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 16px 0;
  min-width: 0;
}
.dock-work-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  padding: 4px 11px;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  cursor: pointer;
}
.dock-work-chip:hover,
.dock-work-chip.on {
  border-color: var(--bd);
  background: var(--soft);
  color: var(--blue2);
}
.dock-work-chip b {
  color: var(--ink);
  font-weight: 600;
}
.dock-work-chip .dw-count {
  font-family: var(--sans);
  letter-spacing: -0.02em;
}
.dock-work-panel {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 100%;
  z-index: 16;
  display: flex;
  flex-direction: column;
  max-height: min(48vh, 320px);
  margin-bottom: 7px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}
.dock-panel-enter-active,
.dock-panel-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.dock-panel-enter-from,
.dock-panel-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
.dock-work-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--line);
  background: transparent;
}
.dock-work-tab {
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--muted);
  padding: 0;
  font-family: var(--sans);
  font-size: calc(var(--ui-font-size) - 1.5px);
  font-weight: 500;
  cursor: pointer;
}
.dock-work-tab:hover {
  color: var(--ink);
}
.dock-work-tab.on {
  background: none;
  color: var(--ink);
  font-weight: 700;
}
.dock-work-tab.static {
  cursor: default;
  color: var(--ink);
  font-weight: 700;
}
.dock-work-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--muted);
  padding: 4px;
  cursor: pointer;
}
.dock-work-close:hover {
  background: none;
  color: var(--ink);
}
.dock-work-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dock-work-body :deep(.taskspane) {
  padding: 10px 12px 12px;
}
.dock-work-body :deep(.taskspane .tp-head) {
  display: none;
}
.dock-work-body :deep(.todo-card.tab-mode) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.dock-work-body :deep(.todo-card.tab-mode .tc-list) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px 12px;
}

@media (max-width: 640px) {
  .dock-workbar {
    padding: 2px 10px 9px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .dock-work-chip {
    flex: none;
    max-width: min(82vw, 360px);
  }
  .dock-work-panel {
    left: 10px;
    right: 10px;
    max-height: 45dvh;
  }
  .dock-work-head {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .dock-work-tab {
    flex: none;
    white-space: nowrap;
  }
}

/* A docked approval can carry a tall diff/file preview; cap it so it never
   pushes the rest of the dock off-screen, scrolling internally instead. Match
   the question card's outer margin so both docked prompts sit identically. */
.dock-approval {
  margin: 8px 0;
  max-height: 50vh;
  overflow-y: auto;
}
@media (max-width: 640px) {
  .dock-approval {
    max-height: 45dvh;
    margin: 8px 10px;
  }
}

/* Capped desktop dock (center/left): the fused composer card is the visual
   anchor. No panel border, no hard dividers — the dock blends into the (white)
   chat surface and the rounded composer card defines the area. Mobile keeps its
   own flat full-width bar. */
.dock:not(.align-mobile) :deep(.composer) {
  border-top: none;
  background: transparent;
  padding-bottom: 14px;
}

/* Merged files pane: horizontal split (navigator | divider | content), no outer scroll */
.panes.files-layout {
  display: flex;
  flex-direction: row;
  overflow: hidden;
}
.panes.terminal-layout {
  overflow: hidden;
}

/* Left navigator: the Changed|All toggle + (changed list / full tree). */
.files-nav {
  width: 38%;
  min-width: 180px;
  max-width: 340px;
  flex: none;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.files-nav-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* Changed | All segmented toggle (+ list/tree layout toggle on the right). */
.nav-seg {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.seg-group {
  flex: 1;
  display: flex;
  min-width: 0;
}
.layout-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  color: var(--muted);
  cursor: pointer;
}
.layout-toggle:hover { color: var(--blue); border-color: var(--bd); }
.seg-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--muted);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
  padding: 4px 8px;
  cursor: pointer;
  transition: background 0.14s, color 0.14s;
}
.seg-btn:first-child { border-radius: 6px 0 0 6px; border-right: none; }
.seg-btn:last-child { border-radius: 0 6px 6px 0; }
.seg-btn:hover { color: var(--ink); }
.seg-btn.on {
  background: var(--soft);
  color: var(--blue2);
  font-weight: 600;
  border-color: var(--bd);
}
.seg-n {
  font-size: max(9px, calc(var(--ui-font-size) - 4.5px));
  background: var(--blue);
  color: var(--bg); /* on-accent text */
  border-radius: 8px;
  padding: 0 5px;
  line-height: 1.5;
}
.seg-btn.on .seg-n { background: var(--blue); }

/* Layout toggle bar (tree/list) sits on its own row below the Changed|All toggle. */
.nav-tools {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 4px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}

.files-divider {
  width: 1px;
  background: var(--line);
  flex: none;
  align-self: stretch;
}

/* Right content: adaptive (diff detail / file preview / empty). */
.files-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.files-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 24px;
  color: var(--muted);
  font-size: calc(var(--ui-font-size) - 1.5px);
  text-align: center;
}

/* Make the child components (DiffView list/detail, FileTree, FilePreview) fill
   their pane and scroll internally. */
.files-nav-body :deep(.changes-pane),
.files-content :deep(.changes-pane),
.files-content :deep(.file-preview) {
  flex: 1;
  min-height: 0;
}

/* ---------------------------------------------------------------------------
   Merged files pane MOBILE drill-down: a single full-width column. The navigator
   fills the pane; picking a file swaps to a full-width content pane with its own
   Back row. v-show hides the inactive half. No side-by-side split.
   --------------------------------------------------------------------------- */
@media (max-width: 640px) {
  .nav-seg {
    gap: 6px;
    padding: 6px 8px;
  }
  .seg-btn {
    min-width: 0;
    padding: 6px 6px;
    font-size: var(--ui-font-size-xs);
  }
  .seg-n {
    flex: none;
    padding: 0 4px;
  }

  .panes.files-layout {
    flex-direction: column;
  }
  .files-nav,
  .files-content {
    width: 100%;
    max-width: none;
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .files-content :deep(.file-preview) { flex: 1; min-height: 0; }

  .files-back {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 44px;
    padding: 8px 14px;
    background: var(--panel);
    border: none;
    border-bottom: 1px solid var(--line);
    color: var(--dim);
    font-family: var(--mono);
    font-size: var(--ui-font-size-lg);
    cursor: pointer;
    text-align: left;
  }
  .files-back:active { background: var(--panel2); }
  .files-back-label { font-weight: 600; }
}

/* "New messages" floating pill */
.newmsg-pill {
  position: absolute;
  bottom: 112px; /* above the Composer toolbar */
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px 6px 10px;
  background: var(--blue);
  color: var(--bg); /* on-accent text */
  border: none;
  border-radius: 20px;
  font-size: var(--ui-font-size);
  font-family: var(--mono);
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
  z-index: 10;
  white-space: nowrap;
}
.newmsg-pill:hover {
  background: var(--blue2);
}
@media (max-width: 640px) {
  .newmsg-pill {
    bottom: max(98px, calc(env(safe-area-inset-bottom) + 88px));
    max-width: calc(100vw - 28px);
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
.pill-chevron {
  width: 14px;
  height: 14px;
  flex: none;
}

/* Pill enter/leave transition */
.pill-enter-active,
.pill-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}
.pill-enter-from,
.pill-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

/* Manual-abort toast: centered near the top of the conversation pane */
.abort-toast {
  position: fixed;
  top: 56px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 50;
  padding: 8px 18px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.12);
  font-size: var(--ui-font-size);
  font-family: var(--sans);
  color: var(--ink);
  white-space: nowrap;
  pointer-events: none;
}
.abort-toast-text {
  display: flex;
  align-items: center;
  gap: 6px;
}
.abort-toast-text::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
  flex: none;
}

/* Abort-toast enter/leave transition */
.abort-toast-enter-active,
.abort-toast-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.abort-toast-enter-from,
.abort-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-6px);
}
</style>
