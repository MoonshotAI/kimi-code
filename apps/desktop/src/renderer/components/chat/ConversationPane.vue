<!-- apps/kimi-web/src/components/chat/ConversationPane.vue -->
<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, provide, ref, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ActivationBadges, ApprovalBlock, ChatTurn, ConversationStatus, FilePreviewRequest, OpenMediaRequest, PermissionMode, QueuedPromptView, Session, TaskItem, TodoView, TurnAttachment, UIQuestion, WorkspaceView } from '../../types';
import type { AppGoal, AppModel, AppSkill, QuestionResponse, SessionPlan, ThinkingLevel } from '../../api/types';
import type { FileItem } from './MentionMenu.vue';
import type { ManagedMembership, PromptAttachment } from '@moonshot-ai/app-client/client';
import ChatPane from './ChatPane.vue';
import ChatHeader from './ChatHeader.vue';
import Composer from './Composer.vue';
import ChatDock from './ChatDock.vue';
import WorkspaceHome from './WorkspaceHome.vue';
import WorkspaceRecentSessions from './WorkspaceRecentSessions.vue';
import ConversationToc, { type ConversationTocItem } from './ConversationToc.vue';
import TranscriptSearch from './TranscriptSearch.vue';
import KimiDoodle from '../KimiDoodle.vue';
import { Icon, IconButton, Spinner, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';
import { openUpgrade } from '@moonshot-ai/app-core/lib';
import { getVisibleWorkspaces } from '@moonshot-ai/app-core/lib';
import { safeRemove, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { isMacosDesktop } from '@moonshot-ai/app-core/lib';
import { useNativeTerminal } from '../../composables/useNativeTerminal';
import { closestRegion, isEditableTarget, isSelectAllKeyEvent, selectContentsOf } from '@moonshot-ai/app-core/lib';
import { isFindKeyEvent } from '@moonshot-ai/app-core/lib';
import { track } from '../../lib/track';
import { useComposerAutoFocus } from '@moonshot-ai/app-client/composables';
import { turnHasOutput } from '../chatTurnRendering';
import type { TurnFileChange } from '../chatTurnRendering';

const { t } = useI18n();

const props = defineProps<{
  turns: ChatTurn[];
  sessionId?: string;
  approvals?: { approvalId: string; block: ApprovalBlock; agentName?: string; toolCallId?: string }[];
  gitInfo?: { branch: string; ahead: number; behind: number } | null;
  tasks: TaskItem[];
  /** Model-maintained todo list (TodoList tool) — shown as a floating card. */
  todos?: TodoView[];
  goal?: AppGoal | null;
  activationBadges?: ActivationBadges;
  status: ConversationStatus;
  thinking?: ThinkingLevel;
  planMode?: boolean;
  /** The user's not-yet-cashed plan intent (armed) — forwarded to the
      composer's in-input directive pill via the dock. */
  planArmed?: boolean;
  /** The session's persisted plans keyed by toolCallId — forwarded to the
      dock's plan panel. */
  sessionPlans?: Record<string, SessionPlan>;
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
   *  in flight) — the working indicator. */
  working?: boolean;
  /** End reason of the session's latest turn (server-persisted) — 'cancelled'
   *  marks the last assistant turn as manually stopped in the transcript. */
  lastTurnReason?: 'completed' | 'cancelled' | 'failed' | null;
  /** Terminal error of the session's latest main turn, captured live from the
   *  agent's error event — the failed-turn card's title kind, detail line and
   *  diagnostics meta. */
  turnError?: { code?: string; message?: string; statusCode?: number; requestId?: string } | null;
  /** Live step-retry state of the running main turn — the working indicator
   *  narrates the retry backoff instead of looking stuck. */
  turnRetry?: { nextAttempt: number; maxAttempts: number } | null;
  /** A modal/overlay layer is open above the conversation — it owns Escape, so
   *  the pane's Esc-to-interrupt stays quiet while it is open. */
  overlayOpen?: boolean;
  /** True while the empty-composer first prompt is being created + submitted.
   *  Drives the empty-session "starting conversation…" loading state. */
  starting?: boolean;
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
  /** Daemon auth/provider readiness (GET /auth ready) — forwarded to the
      composer, which shows a sign-in entry instead of the model pill when
      nothing is usable. */
  authReady?: boolean;
  /** Managed-account sign-in state — forwarded to the composer (a signed-in
      account never gets the sign-in entry). */
  managedSignedIn?: boolean;
  /** Membership of the signed-in managed account — forwarded to the composer
      ('free' swaps the model pill for the upgrade entry). */
  managedMembership?: ManagedMembership;
  /** Starred model ids shown at the top of the composer's quick-switch dropdown. */
  starredIds?: string[];
  /** Session skills shown in the composer `/` menu. */
  skills?: AppSkill[];
  /** Whether the session skill list finished loading — forwarded to the
      composer (a revived pill naming a GONE skill only degrades once the
      list can be trusted). */
  skillsLoaded?: boolean;
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
  /** The draft workspace's recent sessions (open first, then done), shown
   *  under the centred composer on the workspace home (desktop empty state). */
  recentSessions?: Session[];
  /** How the current draft was entered: 'workspace' renders the workspace
   *  home (no doodle); 'newChat' (default) keeps the classic doodle hero. */
  draftEntry?: 'newChat' | 'workspace';
  /** Active session title, shown in the chat header. */
  sessionTitle?: string;
  /** True when the active session is archived (completed) — drives the chat
   *  header's Done pill + reopen button (PR-merge semantics). */
  sessionArchived?: boolean;
  /** GitHub PR for the current branch, when known (shown in the chat header). */
  pr?: { number: number; state: string; url: string } | null;
}>();

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: PromptAttachment[] }];
  steer: [payload: { text: string; attachments: PromptAttachment[] }];
  approval: [approvalId: string, response: { decision: 'approved' | 'rejected' | 'cancelled'; scope?: 'session'; feedback?: string }];
  cancelTask: [taskId: string];
  answer: [questionId: string, response: QuestionResponse];
  dismiss: [questionId: string];
  command: [payload: { cmd: string; attachments: PromptAttachment[]; restoreText?: string; skillName?: string }];
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
  /** Composer sign-in entry (no models): deep-link to the settings account tab. */
  login: [];
  openFile: [target: FilePreviewRequest];
  openMedia: [payload: OpenMediaRequest];
  openTurnDiff: [change: TurnFileChange];
  openCompaction: [target: { turnId: string }];
  openAgent: [toolCallId: string];
  /** Chat header / files pane: focus the diff detail layer and refresh git status. */
  openChanges: [];
  refreshGitStatus: [];
  /** Edit + resend the last user message (App undoes, then refills composer). */
  editMessage: [payload: { text: string; attachments?: TurnAttachment[] }];
  /** Empty-composer workspace picker: start a new conversation elsewhere. */
  selectWorkspace: [workspaceId: string];
  /** Empty-composer workspace picker: create a new workspace. */
  addWorkspace: [];
  /** Workspace home (empty state): open one of the recent sessions. */
  selectSession: [id: string];
  /** Chat header: open the GitHub PR in a new tab. */
  openPr: [url: string];
  /** Chat header / session row: rename current session. */
  renameSession: [id: string, title: string];
  /** Chat header / session row: fork current session. */
  forkSession: [id: string];
  /** Chat header / session row: archive (mark done) current session. */
  archiveSession: [id: string];
  /** Chat header: reopen a done (archived) session. */
  restoreSession: [id: string];
  /** Chat header: export current session. */
  exportSession: [id: string];
  /** Workspace home's 查看更多 entry: open the session admin page with the
   *  draft workspace pre-selected in the filter bar. */
  openSessionAdmin: [workspaceId?: string];
}>();

// Empty-composer workspace picker.
const wsPickOpen = ref(false);
// Flip above the chip when there's more room there, and clamp the panel's
// max-height to the scrollport so opening it can't shift the centred composer.
const wsPickUp = ref(false);
const wsPickMaxHeight = ref<string | null>(null);

const activeWorkspaceLabel = computed(() => {
  const w = props.workspaces?.find((ws) => ws.id === props.activeWorkspaceId);
  return w?.name ?? props.workspaceName ?? '';
});

// The workspace home replaces the doodle hero only for drafts entered from a
// workspace directory row (or the add-workspace flow) — the primary 新建会话
// draft, mobile and the starting transition keep the classic empty state.
const showWorkspaceHome = computed(
  () => !props.mobile && !props.starting && props.draftEntry === 'workspace',
);

const hasWorkspaces = computed(() => (props.workspaces?.length ?? 0) > 0);

// Signed-in free managed account with no other models configured: besides the
// composer's upgrade pill, the empty-session landing shows a louder guidance
// banner above the composer.
const showUpgradeBanner = computed(
  () =>
    props.authReady === false &&
    (props.models?.length ?? 0) === 0 &&
    props.managedSignedIn === true &&
    props.managedMembership === 'free',
);

// Capped recent list, no expander.
const visibleWorkspaces = computed(() =>
  getVisibleWorkspaces(props.workspaces ?? [], props.activeWorkspaceId, false),
);

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
    // 4px matches the panel's top/bottom offset (--space-1).
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

/** Whether the active composer has no text and no attachments — a late
    restore (a failed async send returning out of band) may only land when
    nothing newer was typed in the meantime. */
function isComposerEmpty(): boolean {
  const composer = dockedComposerRef.value ?? emptyComposerRef.value;
  return composer ? (composer.isEmpty?.() ?? true) : true;
}

function handleCopyConversationCopied(): void {
  copyConversationCopied.value = true;
  if (copyConversationCopiedTimer !== null) clearTimeout(copyConversationCopiedTimer);
  copyConversationCopiedTimer = setTimeout(() => {
    copyConversationCopiedTimer = null;
    copyConversationCopied.value = false;
  }, 2000);
}

// The daemon maps engine QUESTION tasks to the wire kind 'tool' (the schema
// has no 'question' literal) — those are the AskUserQuestion flows, which
// already have their own entry point in the message stream's QuestionCard.
// Identify them by the engine's idPrefix (`question-XXXXXXXX`), not by output
// presence: a genuine background tool task must stay listed — with its
// cancel — from the moment taskCreated lands, before any progress chunk
// exists (a long-silent task would otherwise never surface at all).
const bashTasks = computed(() =>
  props.tasks.filter(
    (t) => t.kind === 'bash' || (t.kind === 'tool' && !t.id.startsWith('question-')),
  ),
);
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
  if (task?.agentId) return task.agentId;
  // A subagent task synthesized from a text delta (client subscribed after the
  // spawn, so the lifecycle parentToolCallId was missed) has no parentToolCallId.
  // When exactly one such unmapped subagent task exists, attribute it to this
  // Agent tool call so the Open-detail button stays reachable.
  const unmapped = tasks.filter(
    (tk) => tk.kind === 'subagent' && !tk.parentToolCallId && tk.agentId,
  );
  if (unmapped.length === 1) return unmapped[0]!.agentId;
  return undefined;
}
provide('resolveAgentTaskId', resolveAgentTaskId);
// The Agent tool card's model meta: same task resolution as above, then the
// alias is mapped to a friendly display name through the shared App-level
// mapper, with the effort riding along whenever a concrete level exists.
// Undefined for history rows whose lifecycle events predate the session load.
const modelDisplay = inject<(alias: string | undefined) => string | undefined>('modelDisplay');
const subagentEffort = inject<(effort: string | undefined) => string | undefined>('subagentEffort');
function resolveAgentModel(
  toolCallId: string,
  agentId?: string,
): { display?: string; effort?: string } | undefined {
  // A persisted agent id (from agentRefs / the saved tool result) addresses
  // the task directly — restored rows may be keyed by agent id with no
  // parentToolCallId at all.
  const target = agentId ?? resolveAgentTaskId(toolCallId);
  if (target === undefined) return undefined;
  const task = props.tasks.find((tk) => tk.agentId === target || tk.id === target);
  // Effort is independent of the model label: an undisplayable alias must not
  // take a concrete effort down with it.
  const display = modelDisplay?.(task?.model);
  const effort = subagentEffort?.(task?.thinkingEffort);
  if (display === undefined && effort === undefined) return undefined;
  return { display, effort };
}
provide('resolveAgentModel', resolveAgentModel);
// Only manual toggles on SETTLED rows call this: the row is pinned while its
// body transition runs, breaking the bottom follow on purpose; the follow
// state is re-decided from real geometry once the pin settles (see
// settleAfterPin). Live (streaming/running) rows skip the pin — the follow
// absorbs their growth as read-along.
provide('pinScroll', pinScrollFor);
const todoDoneCount = computed(() => (props.todos ?? []).filter((td) => td.status === 'done').length);
// The goal rides the dock as one more work pill, so it keeps the workbar (and
// the panel) alive even without task/todo items. Queued prompts don't count —
// they render inline in the transcript and own no pill.
const hasDockWork = computed(() =>
  props.goal != null ||
  bashTasks.value.length > 0 ||
  subagentTasks.value.length > 0 ||
  (props.todos?.length ?? 0) > 0,
);
const dockPanel = ref<'bash' | 'subagent' | 'todos' | 'goal' | 'plan' | null>(null);
const changesCount = computed(() => (props.gitInfo ? props.changes?.length ?? 0 : 0));

function toggleDockPanel(panel: 'bash' | 'subagent' | 'todos' | 'goal' | 'plan'): void {
  dockPanel.value = dockPanel.value === panel ? null : panel;
}

function closeDockPanel(): void {
  dockPanel.value = null;
}

function focusGoal(): void {
  // The composer toolbar's goal button opens the goal's dock panel (the goal
  // pill's expanded view).
  if (props.goal) dockPanel.value = 'goal';
}

// A panel whose backing item went away closes itself — the goal pill's panel
// would otherwise linger empty after a cancel/complete while other dock work
// remains (hasDockWork only watches the aggregate).
watch(
  () => [props.goal, bashTasks.value.length, subagentTasks.value.length, props.todos?.length, props.planMode, props.sessionPlans] as const,
  () => {
    const panel = dockPanel.value;
    if (panel === null) return;
    const backed =
      (panel === 'goal' && props.goal != null) ||
      (panel === 'bash' && bashTasks.value.length > 0) ||
      (panel === 'subagent' && subagentTasks.value.length > 0) ||
      (panel === 'todos' && (props.todos?.length ?? 0) > 0) ||
      (panel === 'plan' &&
        (props.planMode === true || Object.keys(props.sessionPlans ?? {}).length > 0));
    if (!backed) closeDockPanel();
  },
);

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
  const items = conversationTocItems.value;
  if (items.length === 0) return;

  // When pinned to the bottom (auto-follow / short content), the latest query is
  // the active one even if its message sits below the pane's vertical middle —
  // otherwise the highlight would lag one query behind at the bottom.
  if (distanceFromBottom() <= BOTTOM_THRESHOLD) {
    activeTurnId.value = items[items.length - 1]!.id;
    return;
  }

  // Anchor positions in pane-content coordinates (viewport top − pane top +
  // scrollTop): the O(N) getBoundingClientRect pass runs only when geometry
  // went dirty (content growth, resize, rebind); pure-scroll frames reuse the
  // cache — a long transcript no longer pays O(N) forced layout per scroll
  // frame. pane top is re-read on the same dirty pass, so header/pane shifts
  // stay exact.
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
  const userIds = new Set(items.map((item) => item.id));
  const paneMiddle = pane.scrollTop + pane.clientHeight / 2;
  // Otherwise the active highlight tracks the query that owns the current
  // viewport: the last user-turn anchor at or above the middle.
  let bestId: string | null = null;
  for (const anchor of tocAnchorsCache) {
    if (!userIds.has(anchor.id)) continue;
    if (anchor.top <= paneMiddle) bestId = anchor.id;
  }
  activeTurnId.value = bestId ?? items[0]!.id;
}

// See updateActiveTocQuery: null = not measured yet, dirty = re-measure on the
// next query. Marked by content mutation, resize, rebind, and table layout.
let tocAnchorsCache: { id: string; top: number }[] | null = null;
let tocAnchorsDirty = true;

function markTocAnchorsDirty(): void {
  tocAnchorsDirty = true;
}

let activeTocRaf = 0;

// Scroll events fire faster than once per frame; merge the O(N) anchor
// measurement into a single run per frame (same raf pattern as
// scheduleTocTableHitTest). One-shot callers (watchers, mount) invoke
// updateActiveTocQuery directly.
function scheduleActiveTocUpdate(): void {
  if (activeTocRaf) return;
  activeTocRaf = raf(() => {
    activeTocRaf = 0;
    updateActiveTocQuery();
  });
}

// --- TOC occlusion by wide tables -------------------------------------------
// Manually widened markdown tables (via the toggle injected by app-markdown's
// tableWide.ts, up to --p-table-max) can extend past the TOC rail,
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

function onTableLayout(): void {
  scheduleTocTableHitTest();
  markTocAnchorsDirty();
}

function updateTocTableOcclusion(): void {
  const pane = panesRef.value;
  const toc =
    !props.mobile && pane
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

// Transcript find bar (Cmd/Ctrl+F) — floats over the transcript's top-right,
// scopes its search to the rendered .chat inside .panes and scrolls matches
// into view via revealTranscriptElement.
const transcriptSearchOpen = ref(false);
const transcriptSearchRef = ref<InstanceType<typeof TranscriptSearch> | null>(null);
// Element focused before the find bar opened — focus returns to it on close,
// or typing continues into the void (browser drops focus to <body>).
let searchPreFocus: Element | null = null;

function openTranscriptSearch(): void {
  // An empty session has nothing to search (and no .chat to scope to).
  if (props.turns.length === 0) return;
  if (transcriptSearchOpen.value) {
    transcriptSearchRef.value?.focusInput();
    return;
  }
  searchPreFocus = document.activeElement;
  transcriptSearchOpen.value = true;
  track('search_opened', {});
}

function closeTranscriptSearch(): void {
  transcriptSearchOpen.value = false;
  void nextTick(() => {
    if (searchPreFocus instanceof HTMLElement && searchPreFocus.isConnected) {
      searchPreFocus.focus();
    }
    searchPreFocus = null;
  });
}

// The empty-session layout (centred composer) has no transcript — the find
// bar must not float over it. Route through the unified close path so the
// pre-open focus is restored (an unmounted input would drop it to <body>).
watch(
  () => props.turns.length === 0 && !props.sessionLoading,
  (empty) => {
    if (empty && transcriptSearchOpen.value) closeTranscriptSearch();
  },
);
const chatDockStyle = computed(() => ({
  '--panes-scrollbar-width': `${panesScrollbarWidth.value}px`,
}));
// The dock paints a --fade veil band above its own box (see .chat-dock::before
// in ChatDock.vue), which offsetHeight does not include. Reserve it in the
// transcript's scroll padding too, or the last rows end up under the veil with
// no room to scroll clear. Must match ChatDock's --fade.
const DOCK_VEIL_FADE_PX = 48;
const chatLayoutStyle = computed(() => ({
  '--chat-dock-height': `${dockHeight.value + DOCK_VEIL_FADE_PX}px`,
}));
type ComposerHandle = {
  loadForEdit: (value: string) => boolean | void;
  loadAttachmentsForEdit: (atts: TurnAttachment[]) => void;
  focus: () => void;
  /** True while any composer popup (model/permission dropdown, slash/mention
   *  menu) is open — such a popup owns Escape. */
  anyPopupOpen?: boolean;
  /** True when the draft is empty — lets undo avoid clobbering user input. */
  isEmpty?: () => boolean;
};
type RefArg = Element | (ComponentPublicInstance & Partial<ComposerHandle>) | null;

function toHtmlEl(el: RefArg): HTMLElement | null {
  if (el instanceof HTMLElement) return el;
  if (el && '$el' in el && el.$el instanceof HTMLElement) return el.$el;
  return null;
}

let panesGeomRaf = 0;

// Batched behind one rAF and guarded by value: the raw offset* reads force a
// synchronous layout when they run while the DOM is dirty (every streaming
// frame via the ResizeObserver), and a same-value ref write still re-renders
// the style bindings — one of the per-frame RecalcStyle drivers.
function updatePanesScrollbarWidth(): void {
  if (panesGeomRaf) return;
  panesGeomRaf = raf(() => {
    panesGeomRaf = 0;
    const el = panesRef.value;
    const sbw = el ? Math.max(0, el.offsetWidth - el.clientWidth) : 0;
    if (sbw !== panesScrollbarWidth.value) panesScrollbarWidth.value = sbw;
    const dh = dockRef.value?.offsetHeight ?? 0;
    if (dh !== dockHeight.value) dockHeight.value = dh;
  });
}

function bindChatPane(el: RefArg): void {
  const node = toHtmlEl(el);
  // Vue re-invokes function refs on EVERY patch of the element — during
  // streaming that is every frame, and rebindScrollObservers' observer
  // disconnect/observe cycle plus scrollHeight/clientHeight reads force a
  // full-document layout each time. Rebind only when the node actually
  // changes (mount / unmount / swap).
  if (node === panesRef.value) return;
  panesRef.value = node;
  if (node) rebindScrollObservers();
}

function bindChatDock(el: RefArg): void {
  const node = toHtmlEl(el);
  // Same every-patch ref re-fire guard as bindChatPane: without it each patch
  // rebuilds the composer handle (fresh bound closures) and retriggers every
  // consumer of dockedComposerRef per frame.
  if (node === dockRef.value) return;
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
      // Read lazily — copying the value at bind time would freeze it.
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
}

// Silence noUnusedLocals: both are used as :ref callbacks in the template.
void bindChatPane;
void bindChatDock;

const following = ref(true);
const showPill = ref(false);
// Overlay-style scrollbar state: true from a scroll event until ~0.9s after
// the last one; drives the .scrolling class on .panes.
const panesScrolling = ref(false);
let panesScrollHideTimer: ReturnType<typeof setTimeout> | null = null;

/** Within this many pixels from the bottom counts as "at the bottom" —
    scrolling DOWN into this zone re-enables the follow. */
const BOTTOM_THRESHOLD = 80;
const USER_ACTION_FOLLOW_LOCK_MS = 1000;

function distanceFromBottom(): number {
  const el = panesRef.value;
  if (!el) return 0;
  // RO-maintained heights, not live reads: scrollHeight/clientHeight on a dirty
  // DOM force a synchronous layout, and this runs on every follow-driven scroll
  // frame. The cache lags ≤1 frame — harmless for the bottom-proximity checks
  // this feeds (follow / pill / TOC highlight).
  return lastObservedScrollHeight - el.scrollTop - lastObservedClientHeight;
}

let lastScrollTop = 0;
let userActionFollowUntil = 0;
let lastSmoothScroll = 0;
// While a find-bar reveal scroll is in flight (the smooth animation plus the
// 480ms settle correction), the scroll-DOWN-into-the-zone branch in
// onPanesScroll must NOT re-arm the bottom follow: the reveal deliberately
// broke it (following=false), and a match inside the bottom threshold would
// otherwise re-enable it mid-animation, letting the next stream growth yank
// the viewport back to the tail and lose the match.
let searchScrollFollowSuppressUntil = 0;
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
  // Overlay-style scrollbar: reveal the thumb while scrolling, hide it again
  // shortly after the last scroll event (see .panes::-webkit-scrollbar-thumb).
  panesScrolling.value = true;
  if (panesScrollHideTimer) clearTimeout(panesScrollHideTimer);
  panesScrollHideTimer = setTimeout(() => {
    panesScrolling.value = false;
    panesScrollHideTimer = null;
  }, 900);
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
    // Shrinking content (fold collapse, pane widening) makes the browser clamp
    // scrollTop upward — not a user scroll-away. The RO cache behind dist lags
    // a frame here, so recheck live: a clamp lands flush on the new bottom.
    const liveDist = el.scrollHeight - top - el.clientHeight;
    if (liveDist > 1) {
      following.value = false;
      showPill.value = true;
    }
  } else if (
    dist <= BOTTOM_THRESHOLD &&
    top > lastScrollTop + 1 &&
    Date.now() >= searchScrollFollowSuppressUntil
  ) {
    following.value = true;
    showPill.value = false;
  }
  lastScrollTop = top;
  scheduleActiveTocUpdate();
}

function scrollToBottom(smooth = false): void {
  const el = panesRef.value;
  following.value = true;
  showPill.value = false;
  // A newer scroll writer supersedes a pending TOC settle correction.
  cancelTocSettleCorrection();
  if (!el) return;
  // A smooth scroll (e.g. right after sending a message) needs time to play;
  // skip instant jumps during the guard window so the streaming follow doesn't
  // immediately snap to the bottom and cancel the animation.
  if (!smooth && performance.now() < smoothScrollUntil) return;
  if (smooth) {
    smoothScrollToBottom();
  } else {
    // Write-only jump: scrollHeight is NOT read here — on a dirty DOM (every
    // streaming frame) that read forces a synchronous full-document layout.
    // The ResizeObserver-maintained height lags at most one frame, and the
    // follow keeps firing while content streams, so the pane converges to the
    // real bottom without ever forcing layout. Never scroll backwards: a lagging
    // cache must not yank the pane up.
    el.scrollTop = Math.max(el.scrollTop, lastObservedScrollHeight);
  }
  lastScrollTop = el.scrollTop;
}

let smoothRaf = 0;

// raf-driven smooth scroll: the target is re-read from scrollHeight every
// frame, so streaming growth during the animation still lands on the true
// bottom (a one-shot scrollTo would freeze the target at click time).
function smoothScrollToBottom(ms = 320): void {
  const el = panesRef.value;
  if (!el) return;
  // A previous animation may still be running (e.g. rapid consecutive
  // submits): its loop would survive cancelActiveScrollWrites (which only
  // holds the latest handle) and keep dragging the viewport to the bottom.
  if (smoothRaf) {
    cancelRaf(smoothRaf);
    smoothRaf = 0;
  }
  // The CSS reduced-motion rules can't reach a JS-driven scroll — honor the
  // preference here by landing on the bottom instantly instead of animating.
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
      // The guard exists to protect the in-flight animation from instant
      // follow writes; lift it the moment the animation completes so the
      // follow resumes on the very next change instead of stalling until the
      // guard's tail expires.
      smoothScrollUntil = 0;
    }
  };
  smoothRaf = raf(tick);
}

type ScrollAnchor = { kind: 'turn' | 'tool'; id: string; top: number };

function scrollAnchorTop(container: HTMLElement, node: HTMLElement): number {
  // Tool calls inside a collapsed fold (activity run / group) still exist
  // under an inert, clipped body. Anchor them to the visible fold row so
  // hidden content cannot create a fake layout delta while the stable tool id
  // remains usable.
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

// content-visibility: auto estimates off-screen message heights, so the smooth
// scrollIntoView lands on an estimated position that drifts as real layouts
// replace the estimates. Re-measure once the animation has settled (~480ms)
// and correct to the real position; cancelled when the user takes over
// scrolling (any wheel/touch input, a scrollbar grab, or a newer scroll
// writer — see cancelTocSettleCorrection's call sites).
let tocSettleTimer: ReturnType<typeof setTimeout> | null = null;

function cancelTocSettleCorrection(): void {
  if (tocSettleTimer !== null) {
    clearTimeout(tocSettleTimer);
    tocSettleTimer = null;
  }
}

// Shared "scroll a transcript element into view" dance: breaks the bottom
// follow, shows the new-messages pill when far from the tail, smooth-scrolls,
// then re-centers once content-visibility's estimated boxes have settled.
// Used by the TOC (turn anchors) and the find bar (match elements).
function revealTranscriptElement(target: HTMLElement): void {
  cancelActiveScrollWrites();
  following.value = false;
  showPill.value = distanceFromBottom() > BOTTOM_THRESHOLD;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  cancelTocSettleCorrection();
  tocSettleTimer = setTimeout(() => {
    tocSettleTimer = null;
    const el2 = panesRef.value;
    if (!el2 || !target.isConnected) return;
    const delta = (target.getBoundingClientRect().top + target.offsetHeight / 2)
      - (el2.getBoundingClientRect().top + el2.clientHeight / 2);
    if (Math.abs(delta) > 48) el2.scrollTop += delta;
  }, 480);
}

function scrollToTurn(turnId: string): void {
  const el = panesRef.value;
  if (!el) return;
  const target = el.querySelector<HTMLElement>(`.turn-anchor[data-turn-id="${attrEscape(turnId)}"]`);
  if (!target) return;
  revealTranscriptElement(target);
}

// Center the match inside every scrollable ancestor between it and the pane
// (tool-output cards, grep results…), on BOTH axes — long code lines hide in
// overflow-x containers too. scrollIntoView on the parent can't do this: a
// parent taller than the inner viewport only aligns its own edge. The rect
// is re-read per level — every scroll moves it.
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

// Range-based variant for the find bar: centers the MATCH ITSELF, not the
// (possibly viewport-tall) element wrapping it — a long paragraph or code
// block with several matches would otherwise re-center the same parent on
// every navigation step. Falls back to the parent element when the range has
// no layout box (hidden content is filtered out of results, but be safe).
function revealTranscriptRange(range: Range): void {
  const el = panesRef.value;
  if (!el) return;
  const parent = range.startContainer.parentElement;
  cancelActiveScrollWrites();
  following.value = false;
  showPill.value = distanceFromBottom() > BOTTOM_THRESHOLD;
  // Keep the follow OFF for the whole reveal (smooth animation + settle
  // correction) — the scroll-down branch in onPanesScroll would otherwise
  // re-arm it for matches inside the bottom threshold.
  searchScrollFollowSuppressUntil = Date.now() + 700;
  // A match inside a clamped long user message is clipped by overflow:hidden
  // — no scroll can reveal it. Expand the clamp first (the toggle lives in
  // ChatPane's markup), then measure after Vue re-renders.
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
  // Phase 1: nested scroll containers (outer pane can't move them).
  scrollNestedContainersToRange(range, el);
  // Phase 2: center the match's own rect in the outer pane (re-read after
  // the nested scroll).
  const rect = range.getClientRects()[0];
  if (!rect) {
    if (parent instanceof HTMLElement) revealTranscriptElement(parent);
    return;
  }
  const paneRect = el.getBoundingClientRect();
  const centerDelta = (rect.top + rect.height / 2) - (paneRect.top + el.clientHeight / 2);
  // The CSS reduced-motion rules can't reach a JS-driven scroll — honor the
  // preference with an instant landing (same guard as scrollToBottom).
  const smooth =
    typeof window === 'undefined' ||
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollTo({ top: el.scrollTop + centerDelta, behavior: smooth ? 'smooth' : 'auto' });
  // Same content-visibility drift as revealTranscriptElement: re-measure once
  // the smooth scroll has settled and correct to the real position.
  cancelTocSettleCorrection();
  tocSettleTimer = setTimeout(() => {
    tocSettleTimer = null;
    const el2 = panesRef.value;
    const rect2 = range.getClientRects()[0];
    if (!el2 || !rect2) return;
    const paneRect2 = el2.getBoundingClientRect();
    const delta = (rect2.top + rect2.height / 2) - (paneRect2.top + el2.clientHeight / 2);
    if (Math.abs(delta) > 48) el2.scrollTop += delta;
  }, 480);
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
// A manual toggle on a SETTLED row (tool / thinking / fold) always pins the
// row's viewport position while its grid-rows transition runs, so the row
// stays put and only its body opens downward / collapses upward. Pinning
// deliberately breaks the bottom follow: an expanding body pushes the tail
// out of view. The follow state is re-decided from real geometry once the pin
// settles — the bottom back within reach resumes the follow (and hides the
// new-message pill); otherwise the pane stays unfollowed with the pill
// visible. Two kinds of toggles never pin: automatic folds (turn/activity
// settle) and LIVE rows (a streaming thinking / a streaming activity run) —
// those keep growing on their own, so the follow (read-along) or the native
// overflow-anchor off-follow absorbs them. (Tool rows always pin: their
// bodies are height-bounded — OutputPanel caps at 12 lines — so a pin never
// fights unbounded growth, and a tool parked on an approval is static.)
let pinUntil = 0;
let pinRaf = 0;
let pinEl: HTMLElement | null = null;
let pinTargetTop = 0;
// Reactive twin of the pin window for the pane's `is-pinned` class: breaking
// the follow drops `is-following`, which would re-enable native overflow
// anchoring mid-pin and let the browser's anchor fight the pin loop.
const pinActive = ref(false);

function isPinned(): boolean {
  return performance.now() < pinUntil;
}

// The default window matches the --duration-base (160ms) fold transition, with
// 40ms of slack.
function pinScrollFor(el: HTMLElement, ms = 200): void {
  const panes = panesRef.value;
  if (!panes) return;
  // A history restore owns the scroll while older messages prepend.
  if (historyLoadInProgress.value) return;
  // Clean slate: stop queued follow writers, any in-flight smooth scroll and
  // a previous pin (a cancelled pin never settles — the newer writer owns the
  // scroll state). Also clears the user-action follow lock: the toggle is the
  // newer intent.
  cancelActiveScrollWrites();
  // Breaking the follow is the point of the pin: the body opening downward
  // pushes the tail out of view. settleAfterPin() re-decides the state.
  following.value = false;
  pinEl = el;
  pinTargetTop = el.getBoundingClientRect().top;
  pinUntil = performance.now() + ms;
  pinActive.value = true;
  if (pinRaf) return;
  const tick = () => {
    pinRaf = 0;
    // Cancelled — another writer owns the scroll state; never settle.
    if (!pinEl) return;
    // The follow resumed externally (e.g. a new submit) — yield, no settle.
    if (following.value) {
      pinEl = null;
      pinActive.value = false;
      return;
    }
    if (performance.now() >= pinUntil) {
      pinEl = null;
      pinActive.value = false;
      settleAfterPin();
      return;
    }
    const delta = pinEl.getBoundingClientRect().top - pinTargetTop;
    if (delta) panes.scrollTop += delta;
    pinRaf = raf(tick);
  };
  pinRaf = raf(tick);
}

// The transition has run out; re-decide the follow state from real geometry.
// The bottom back within reach (e.g. a collapse pulled the tail back up)
// resumes the follow and hides the pill; anything else keeps the pane
// unfollowed with the pill visible. Resuming the follow deliberately does NOT
// snap to the bottom: an instant jump right after the user's click reads as a
// glitch — the next follow trigger (a streaming delta / a resize) glues the
// tail on its own cadence, and a quiet transcript needs no scroll at all.
function settleAfterPin(): void {
  if (distanceFromBottom() <= BOTTOM_THRESHOLD) {
    following.value = true;
    showPill.value = false;
  } else {
    following.value = false;
    showPill.value = true;
  }
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

// Session id as of the last scrollKey fire: the rewind-smooth below (undo /
// compaction glide) only makes sense WITHIN one session. Across a session
// switch the turns array goes old → empty → new, and a smooth scroll started
// on the shrinking transition keeps reading the NEW content's live
// scrollHeight for 320ms + 420ms of instant-follow guard — the visible
// "loads at the top, then animates to the bottom" flash. Cross-session
// transitions are positioned by the fileReloadKey / sessionLoading watchers
// instead.
let scrollKeySession: string | number | undefined = props.fileReloadKey;

watch(scrollKey, async (next, prev) => {
  const sid = props.fileReloadKey;
  const crossSession = sid !== scrollKeySession;
  scrollKeySession = sid;
  // Prepending older history changes this key; suppress only that exact case so
  // concurrent bottom appends still raise the new-message pill.
  if (historyLoadInProgress.value && isHistoryPrependOnly(prev, next)) {
    scheduleActiveTocUpdate();
    return;
  }
  if (crossSession) {
    scheduleActiveTocUpdate();
    return;
  }
  await nextTick();
  if (following.value || hasUserActionFollowLock()) {
    // A rewind (undo / compaction) shortens the transcript — glide to the new
    // bottom smoothly; growth (new turns / streaming) snaps instantly so the
    // follow keeps up with the tail.
    scrollToBottom(next.length < prev.length);
  } else showPill.value = true;
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

// Per-session scroll state: switching back to a session restores both the scroll
// position and whether the user was following the bottom, instead of always
// jumping to the bottom (which replayed the conversation when the session was
// already there) or getting yanked to the bottom by a new message after
// restoring a scrolled-up position.
const scrollStateBySession = new Map<string, { top: number; following: boolean }>();

// Session-switch settle curtain: ChatPane remounts on every switch (keyed by
// fileReloadKey), so the pane's content first collapses, then the new
// transcript paints at whatever scrollTop the collapsed pane clamped to —
// one visible frame of the conversation's HEAD before the follow/restore
// write lands. Curtain the transcript (spinner stays visible) from the switch
// until the landing write has painted.
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
  // Safety net for edge paths where neither watcher reaches the lift (e.g. the
  // target session errors out of its load): never stay curtained.
  settleLiftTimer = setTimeout(() => {
    sessionSettling.value = false;
    settleLiftTimer = null;
  }, 1200);
}

function liftSessionSettle(): void {
  if (!sessionSettling.value) return;
  // Two frames after the landing write, so the reveal paints the already
  // positioned transcript instead of the pre-scroll one.
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

watch(
  () => props.fileReloadKey,
  async (newKey, oldKey) => {
    const el = panesRef.value;
    if (oldKey && el) {
      scrollStateBySession.set(String(oldKey), { top: el.scrollTop, following: following.value });
    }
    cancelActiveScrollWrites();
    beginSessionSettle();
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
        scheduleStableFollow(36, liftSessionSettle);
      } else {
        liftSessionSettle();
      }
    } else {
      following.value = true;
      lastScrollTop = 0;
      scrollToBottom(false);
      scheduleStableFollow(36, liftSessionSettle);
    }
    markTocAnchorsDirty();
    updateActiveTocQuery();
  },
);

watch(
  () => props.sessionLoading,
  async (loading, was) => {
    if (loading || !was) return;
    following.value = true;
    await nextTick();
    scheduleStableFollow(36, liftSessionSettle);
    scheduleActiveTocUpdate();
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
    scheduleActiveTocUpdate();
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
  // A user takeover (wheel/touch/scrollbar) also ends the find-bar reveal's
  // follow suppression, so a deliberate scroll back to the bottom re-arms
  // following right away. (Reveal paths call this BEFORE setting their own
  // timestamp, so the order stays safe.)
  searchScrollFollowSuppressUntil = 0;
  cancelScheduledFollow();
  pinUntil = 0;
  pinEl = null;
  pinActive.value = false;
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
  if (event.defaultPrevented || event.ctrlKey || event.shiftKey) return;
  // Any wheel input takes over from a pending TOC settle correction — not
  // just the upward scroll that also breaks the follow below.
  cancelTocSettleCorrection();
  if (event.deltaY >= 0 || nestedScrollerCanMoveUp(event)) return;
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
  // Any deliberate touch-drag takes over from a pending TOC settle correction.
  cancelTocSettleCorrection();
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
  markTocAnchorsDirty();
}

function onContentMutated(): void {
  ensureContentObserved();
  scheduleFollow();
  scheduleTocTableHitTest();
  markTocAnchorsDirty();
}

function onVisibilityChange(): void {
  if (typeof document === 'undefined') return;
  if (document.visibilityState === 'visible' && following.value) {
    scheduleStableFollow();
  }
}

// ---------------------------------------------------------------------------
// Undone toast: shown after an undo lands. (Abort feedback is the "Manually
// stopped" divider under the turn — Esc and Stop only fire on the main turn.)
// ---------------------------------------------------------------------------
const undoneToastVisible = ref(false);
let undoneToastTimer: ReturnType<typeof setTimeout> | null = null;
const UNDONE_TOAST_DURATION = 3000;

function showUndoneToast(): void {
  undoneToastVisible.value = true;
  if (undoneToastTimer !== null) clearTimeout(undoneToastTimer);
  undoneToastTimer = setTimeout(() => {
    undoneToastVisible.value = false;
  }, UNDONE_TOAST_DURATION);
}

// ---------------------------------------------------------------------------
// "Press Escape again to undo": Esc classifies once, at press time. A turn
// with no output yet (thinking/text/tool — anything streaming in during the
// abort is cut by the undo anyway) is retracted automatically when the abort
// settles; any other turn gets the hint, and a second Esc (or a click on it)
// undoes without the confirm step.
// ---------------------------------------------------------------------------
const undoHintTurnId = ref<string | null>(null);
let undoHintTimer: ReturnType<typeof setTimeout> | null = null;
const UNDO_HINT_DURATION = 5000;
// Safety net only: a landed abort settles within ~a second; if turn end never
// arrives (e.g. the abort request failed) the mark must not fire late.
const pendingAutoUndoTurnId = ref<string | null>(null);
let autoUndoTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_UNDO_TIMEOUT = 10000;
// True once the daemon confirmed the abort landed (App forwards
// abortCurrentPrompt's result) — the auto-retract fires only on it.
let autoUndoConfirmed = false;

function disarmEscUndo(): void {
  undoHintTurnId.value = null;
  pendingAutoUndoTurnId.value = null;
  autoUndoConfirmed = false;
  if (undoHintTimer !== null) {
    clearTimeout(undoHintTimer);
    undoHintTimer = null;
  }
  if (autoUndoTimer !== null) {
    clearTimeout(autoUndoTimer);
    autoUndoTimer = null;
  }
}

function lastUserTurn(): ChatTurn | null {
  for (let i = props.turns.length - 1; i >= 0; i--) {
    const turn = props.turns[i]!;
    // A goal-continuation turn makes the newest exchange non-user-driven:
    // rewinding would drop the hidden trigger turn while the composer gets
    // the older user text back — there is no user-driven latest exchange.
    if (turn.goalContinuation) return null;
    if (turn.role === 'user') return turn;
  }
  return null;
}

function armEscUndo(): void {
  if (undoHintTurnId.value !== null || pendingAutoUndoTurnId.value !== null) return;
  // Arm only with a main turn in flight and an empty queue (a draining queue
  // would retarget the undo); skill/plugin command turns never arm.
  if (!props.working || (props.queued?.length ?? 0) > 0) return;
  const turn = lastUserTurn();
  if (turn === null || turn.skillActivation !== undefined || turn.pluginCommand !== undefined) return;
  const zeroOutput = props.turns
    .slice(props.turns.indexOf(turn) + 1)
    .every((t) => t.role === 'assistant' && !turnHasOutput(t));
  if (zeroOutput) {
    pendingAutoUndoTurnId.value = turn.id;
    autoUndoConfirmed = false;
    autoUndoTimer = setTimeout(() => {
      pendingAutoUndoTurnId.value = null;
    }, AUTO_UNDO_TIMEOUT);
  } else {
    // The 5s lifetime starts when the hint can actually be seen (turn end).
    undoHintTurnId.value = turn.id;
  }
}

// In-flight guard: a double activation (double-click, key autorepeat) must
// not rewind two exchanges before the first rewind removes the turn.
let escUndoInFlight = false;
let escUndoInFlightTimer: ReturnType<typeof setTimeout> | null = null;
const ESC_UNDO_FALLBACK_MS = 2500;

// Shared by the auto path (turn end) and the second Esc / hint click: undo
// only while the marked turn is still the latest user turn.
function executeEscUndo(turnId: string): void {
  if (escUndoInFlight) return;
  disarmEscUndo();
  const turn = props.turns.find((t) => t.id === turnId);
  if (turn === undefined || turn.role !== 'user' || lastUserTurn()?.id !== turn.id) return;
  // Never clobber an in-progress draft with the rewind.
  const composer = dockedComposerRef.value ?? emptyComposerRef.value;
  if (composer?.isEmpty?.() === false) return;
  escUndoInFlight = true;
  escUndoInFlightTimer = setTimeout(() => {
    escUndoInFlight = false;
    escUndoInFlightTimer = null;
  }, ESC_UNDO_FALLBACK_MS);
  handleEditMessage({ text: turn.text, attachments: turn.attachments });
}

function maybeFireAutoUndo(): void {
  if (pendingAutoUndoTurnId.value === null || props.working || !autoUndoConfirmed) return;
  executeEscUndo(pendingAutoUndoTurnId.value);
}

// Turn end: fire the auto mark if the abort was confirmed; the hint's 5s
// lifetime starts here, now that it can actually be seen.
watch(
  () => props.working,
  (w, was) => {
    if (was !== true || w) return;
    if (pendingAutoUndoTurnId.value !== null) {
      maybeFireAutoUndo();
      return;
    }
    if (undoHintTurnId.value !== null && undoHintTimer === null) {
      undoHintTimer = setTimeout(() => {
        undoHintTurnId.value = null;
        undoHintTimer = null;
      }, UNDO_HINT_DURATION);
    }
  },
);
// A new or removed user message retargets "the last one" — drop both marks.
watch(
  () => lastUserTurn()?.id ?? null,
  (id, prev) => {
    if (id !== prev) disarmEscUndo();
  },
);
watch(() => props.sessionId, disarmEscUndo);
watch(
  () => props.queued?.length,
  (n) => {
    if ((n ?? 0) > 0) disarmEscUndo();
  },
);

// Marks the latest turn when it ended 'cancelled'; zero-output shells are
// never marked.
const interruptedTurnId = computed<string | null>(() => {
  if (props.lastTurnReason !== 'cancelled' || props.working || props.turnActive) return null;
  const last = props.turns[props.turns.length - 1];
  return last?.role === 'assistant' && turnHasOutput(last) ? last.id : null;
});

// The failed-turn card pins to the transcript tail while the session sits idle
// on a model-request failure (the turn may have produced no assistant output,
// so unlike the interrupted marker it is not keyed to an assistant turn).
const turnFailed = computed<boolean>(
  () =>
    props.lastTurnReason === 'failed' &&
    !props.working &&
    !props.turnActive &&
    props.turns.length > 0,
);

// The card's continue action submits a short prompt through the normal path —
// the same recovery the user would type by hand.
function handleResumeTurn(): void {
  followAfterUserAction();
  emit('submit', { text: t('conversation.turnFailedResumeText'), attachments: [] });
}

// The hint shows only while the main turn is idle.
const visibleUndoHintTurnId = computed<string | null>(() =>
  props.working ? null : undoHintTurnId.value,
);

function handleInterrupt(): void {
  // The composer Stop button reaches this handler too — only the keyboard
  // Esc path (onKeyDown) arms. Abort feedback is the "Manually stopped"
  // divider under the turn.
  emit('interrupt');
}

// True while a composer popup (model/permission dropdown, slash/mention menu)
// owns Escape. The docked and empty composers are mutually exclusive.
function composerPopupOpen(): boolean {
  return (dockedComposerRef.value?.anyPopupOpen ?? emptyComposerRef.value?.anyPopupOpen) === true;
}

// IME guard, tracked at document level (composition events bubble): an Escape
// that only cancels a composition candidate — in the approval/question cards,
// the composer, anywhere — must not interrupt the turn.
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

// The last click target — select-all attention signal, see onKeyDown.
let lastPointerTarget: EventTarget | null = null;
function onDocumentPointerDown(event: PointerEvent): void {
  lastPointerTarget = event.target;
}

// Select-all region routing, shared by the keydown path and the desktop's
// native Select All menu item (whose accelerator shadows the keydown there):
// the right detail panel owns the selection when the attended element is
// inside it, the transcript otherwise. Focus usually stays on <body> after
// clicking non-focusable panel text, so the last click is the signal when
// the given target is body.
function selectAllRegion(target: EventTarget | null): void {
  const attended = target instanceof Element && target !== document.body ? target : lastPointerTarget;
  const panel = closestRegion(attended, '.global-preview');
  if (panel) {
    selectContentsOf(panel);
    return;
  }
  const chat = panesRef.value?.querySelector('.chat');
  if (chat) selectContentsOf(chat);
}

function onKeyDown(event: KeyboardEvent): void {
  // The desktop native terminal owns these chords while focused (vim/less/
  // fzf/tmux input); no .terminal-host exists on web — a no-op there.
  if (event.target instanceof Element && event.target.closest('.terminal-host') !== null) {
    return;
  }
  // Escape is owned by whatever sits above the conversation: a modal layer
  // (overlayOpen — it closes that layer), a composer popup (composerPopupOpen),
  // an active IME composition (it only cancels the candidate), or any earlier
  // handler that consumed the key (defaultPrevented). The same keypress must
  // not also interrupt a running prompt behind any of these.
  if (
    event.key === 'Escape' &&
    !props.overlayOpen &&
    !composerPopupOpen() &&
    !event.defaultPrevented &&
    !event.repeat &&
    !isComposingKeyEvent(event)
  ) {
    if (visibleUndoHintTurnId.value !== null) {
      // Hint visible: the second Esc undoes — even while background work
      // keeps the session `running`.
      event.preventDefault();
      executeEscUndo(visibleUndoHintTurnId.value);
    } else if (props.working) {
      // Esc stops the MAIN turn only — background work is cancelled from the
      // dock, or via the composer Stop button (session-wide abort).
      event.preventDefault();
      armEscUndo();
      handleInterrupt();
    }
    return;
  }
  // Cmd/Ctrl+F opens the transcript find bar (browser find-in-page idiom).
  // Deliberately NOT gated on editable targets — find works from the composer
  // too — but overlays own their own keyboard. Only consumed when there is a
  // transcript to search; on an empty session the keypress falls through to
  // the browser's native find.
  if (isFindKeyEvent(event) && !props.overlayOpen && props.turns.length > 0) {
    event.preventDefault();
    openTranscriptSearch();
    return;
  }
  // Cmd/Ctrl+A outside a text field selects the region the user is attending
  // to (see selectAllRegion). The browser default would also paint the
  // selection across the sidebar and panel chrome.
  if (isSelectAllKeyEvent(event) && !props.overlayOpen && !isEditableTarget(event.target)) {
    event.preventDefault();
    selectAllRegion(event.target);
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
        markTocAnchorsDirty();
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
    // Table widen/restore toggles change table geometry without a scroll —
    // re-run the TOC occlusion hit test when they fire (event bubbles up from
    // the table wrapper; see app-markdown's tableWide.ts). Anchor geometry
    // shifts the same way, so the TOC cache goes dirty too.
    panesRef.value?.addEventListener('kimi-table-layout', onTableLayout);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
      document.addEventListener('keydown', onKeyDown);
      // Capture: clicks swallowed mid-bubble still update the attention signal.
      document.addEventListener('pointerdown', onDocumentPointerDown, true);
      document.addEventListener('compositionstart', handleCompositionStart);
      document.addEventListener('compositionend', handleCompositionEnd);
    }
    window.visualViewport?.addEventListener('resize', onVisualViewportResize);
  });
});

onUnmounted(() => {
  panesRef.value?.removeEventListener('kimi-table-layout', onTableLayout);
  if (contentObserver) contentObserver.disconnect();
  if (resizeObserver) resizeObserver.disconnect();
  if (scrollRaf) cancelRaf(scrollRaf);
  if (stableFollowRaf) cancelRaf(stableFollowRaf);
  if (pinRaf) cancelRaf(pinRaf);
  if (smoothRaf) cancelRaf(smoothRaf);
  if (tocHitTestRaf) cancelRaf(tocHitTestRaf);
  if (activeTocRaf) cancelRaf(activeTocRaf);
  if (tocSettleTimer !== null) clearTimeout(tocSettleTimer);
  if (panesScrollHideTimer) clearTimeout(panesScrollHideTimer);
  if (undoneToastTimer !== null) clearTimeout(undoneToastTimer);
  if (undoHintTimer !== null) clearTimeout(undoHintTimer);
  if (autoUndoTimer !== null) clearTimeout(autoUndoTimer);
  if (escUndoInFlightTimer !== null) clearTimeout(escUndoInFlightTimer);
  if (copyConversationCopiedTimer !== null) {
    clearTimeout(copyConversationCopiedTimer);
    copyConversationCopiedTimer = null;
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    document.removeEventListener('compositionstart', handleCompositionStart);
    document.removeEventListener('compositionend', handleCompositionEnd);
  }
  window.visualViewport?.removeEventListener('resize', onVisualViewportResize);
});

function focusComposer(): void {
  (dockedComposerRef.value ?? emptyComposerRef.value)?.focus();
}

// Auto-focus the composer when the active session changes — covers switching
// to an existing session AND the first-send transition, where the empty
// composer unmounts and the docked one mounts (possibly ticks after sessionId
// flips, still disabled while `starting`). Turn end deliberately does not
// refocus. See useComposerAutoFocus.
useComposerAutoFocus({
  sessionId: () => props.sessionId,
  mobile: () => props.mobile === true,
  starting: () => props.starting === true,
  dockedComposer: dockedComposerRef,
  emptyComposer: emptyComposerRef,
});

// App calls this once the daemon rewind has actually landed — the toast
// claims success, so it waits for it.
function notifyUndone(): void {
  showUndoneToast();
}

// App reports the abort outcome here: the auto-retract fires only on a
// confirmed stop — anything else (already completed, request failed) just
// disarms it.
function onAbortOutcome(aborted: boolean): void {
  if (pendingAutoUndoTurnId.value === null) return;
  if (!aborted) {
    // A later "nothing to abort" can't retract an earlier confirmation (a
    // double-Esc mid-flight aborts an already-aborted prompt).
    if (!autoUndoConfirmed) disarmEscUndo();
    return;
  }
  autoUndoConfirmed = true;
  maybeFireAutoUndo();
}

// Native terminal toggle for the empty-composer state (desktop-only fork):
// no ChatHeader renders there, so the panel's entry floats top-right instead.
const terminalStore = useNativeTerminal();
const showEmptyTerminalToggle = computed(
  () => !props.mobile && terminalStore.available && props.turns.length === 0 && !props.sessionLoading,
);
function toggleTerminalPanel(): void {
  terminalStore.toggle(props.workspaceRoot);
}

defineExpose({ loadComposerForEdit, isComposerEmpty, focusComposer, notifyUndone, onAbortOutcome, selectAllRegion, focusGoal });
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
      :archived="sessionArchived"
      @open-changes="emit('openChanges')"
      @copy-all="chatPaneRef?.copyConversation()"
      @copy-final-summary="chatPaneRef?.copyFinalSummary()"
      @open-pr="pr && emit('openPr', pr.url)"
      @rename-session="(id, title) => emit('renameSession', id, title)"
      @fork-session="(id) => emit('forkSession', id)"
      @archive-session="(id) => emit('archiveSession', id)"
      @restore-session="(id) => emit('restoreSession', id)"
      @export-session="(id) => emit('exportSession', id)"
    />
    <!-- Empty-composer state renders no ChatHeader (no session context yet), so
         on macOS desktop the conversation column would lose its only window-drag
         region. This zero-chrome strip carries it instead. Absolutely positioned
         over the pane's top, so the centred empty-composer layout is untouched;
         the floating sidebar toggle / new-chat buttons come later in DOM order,
         so their no-drag holes subtract from this region as usual. -->
    <div
      v-else-if="!mobile"
      class="empty-drag"
      :class="{ 'macos-desktop': isMacosDesktop }"
    />
    <!-- Empty-composer terminal entry (desktop-only fork): with no ChatHeader
         rendered, the panel toggle floats top-right instead. Must come AFTER
         the .empty-drag band so its no-drag hole subtracts as usual. -->
    <IconButton
      v-if="showEmptyTerminalToggle"
      class="empty-terminal-btn"
      :class="{ open: terminalStore.open.value }"
      :label="t('terminal.toggle')"
      :tooltip="t('terminal.toggle')"
      @click="toggleTerminalPanel"
    >
      <Icon name="terminal" size="sm" />
    </IconButton>

    <!-- Conversation outline: right edge rail of vertical bars (one per user
         query); hover to expand a labeled panel. -->
    <ConversationToc
      :items="conversationTocItems"
      :active-turn-id="activeTurnId"
      :mobile="mobile"
      :session-loading="sessionLoading"
      :occluded="tocOccludedByTable"
      @select="scrollToTurn"
    />

    <div class="chat-layout" :style="chatLayoutStyle">
      <div
        :ref="bindChatPane"
        class="panes chat-scroll"
        :class="{
          'is-following': following,
          'history-prepending': historyLoadInProgress,
          'is-pinned': pinActive,
          scrolling: panesScrolling,
          'session-settling': sessionSettling,
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
            <!-- Desktop draft entered from a workspace directory = the
                 workspace home (environment actions above the composer, this
                 workspace's recent sessions below) — no brand doodle. A draft
                 from the primary 新建会话 button (and mobile / the starting
                 transition) keeps the classic doodle hero. -->
            <WorkspaceHome
              v-if="showWorkspaceHome"
              :workspace-name="activeWorkspaceLabel"
              :workspace-root="workspaceRoot"
            />
            <div v-else class="empty-hint">
              <KimiDoodle v-if="!starting" class="empty-doodle">
                <template #fallback>
                  <span class="empty-hint-title">{{ t('composer.emptyConversationTitle') }}</span>
                </template>
              </KimiDoodle>
              <span v-else class="empty-hint-title is-starting">
                <Spinner size="sm" />
                <span>{{ t('conversation.starting') }}</span>
              </span>
              <span v-if="!starting" class="empty-hint-text">{{ t('composer.emptyConversation') }}</span>
            </div>
            <!-- Signed-in free account, no usable models: upgrade guidance
                 above the composer (the pill alone is easy to miss). Styled
                 after the design-system Banner(info) recipe. -->
            <div v-if="showUpgradeBanner" class="upgrade-banner">
              <Icon class="upgrade-banner-icon" name="music" size="sm" />
              <span class="upgrade-banner-text">{{ t('composer.upgradeBanner') }}</span>
              <button type="button" class="upgrade-banner-cta" @click="openUpgrade()">
                {{ t('sidebar.upgrade') }}
              </button>
            </div>
            <Composer
              ref="emptyComposerRef"
              class="empty-composer"
              :session-id="sessionId"
              :running="running"
              :working="working"
              :queued="queued"
              :search-files="searchFiles"
              :upload-image="uploadImage"
              :status="status"
              :thinking="thinking"
              :plan-mode="planMode"
              :plan-armed="planArmed"
              :swarm-mode="swarmMode"
              :goal-mode="goalMode"
              :goal="goal"
              :activation-badges="activationBadges"
              :models="models"
              :auth-ready="authReady"
              :managed-signed-in="managedSignedIn"
              :managed-membership="managedMembership"
              :starred-ids="starredIds"
              :skills="skills"
              :skills-loaded="skillsLoaded"
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
              @open-btw="emit('command', { cmd: '/btw', attachments: [] })"
              @create-goal="emit('createGoal', $event)"
              @control-goal="emit('controlGoal', $event)"
              @focus-goal="focusGoal"
              @compact="emit('compact')"
              @pick-model="emit('pickModel')"
              @select-model="emit('selectModel', $event)"
              @login="emit('login')"
            >
              <!-- Workspace picker as an attachment card after the composer
                   card; hidden while starting. -->
              <template v-if="!starting" #footer>
                <div class="ws-bar">
                  <div v-if="hasWorkspaces" class="ws-anchor">
                    <Tooltip :text="t('conversation.switchWorkspace')">
                      <button
                        type="button"
                        class="ws-chip"
                        :class="{ open: wsPickOpen }"
                        :aria-expanded="wsPickOpen"
                        @click.stop="toggleWsPick"
                      >
                        <Icon name="folder" />
                        <span class="ws-chip-name">{{ activeWorkspaceLabel }}</span>
                        <Icon class="ws-chip-chev" name="chevron-down" size="sm" />
                      </button>
                    </Tooltip>
                    <div
                      v-if="wsPickOpen"
                      class="ws-panel"
                      :class="{ up: wsPickUp }"
                      :style="wsPickMaxHeight ? { maxHeight: wsPickMaxHeight } : undefined"
                      role="menu"
                    >
                      <div class="ws-caption">{{ t('workspace.recentLabel') }}</div>
                      <button
                        v-for="w in visibleWorkspaces"
                        :key="w.id"
                        type="button"
                        class="ws-row"
                        :class="{ on: w.id === activeWorkspaceId }"
                        role="menuitem"
                        @click.stop="pickWorkspace(w.id)"
                      >
                        <Icon name="folder" />
                        <span class="ws-info">
                          <span class="ws-name">{{ w.name }}</span>
                          <span class="ws-path">{{ w.shortPath }}</span>
                        </span>
                        <Icon v-if="w.id === activeWorkspaceId" class="ws-check" name="check" size="sm" />
                      </button>
                      <div class="ws-divider" />
                      <button
                        type="button"
                        class="ws-action"
                        role="menuitem"
                        @click.stop="wsPickOpen = false; emit('addWorkspace')"
                      >
                        <Icon name="folder-plus" />
                        <span>{{ t('conversation.pickFolder') }}</span>
                      </button>
                    </div>
                  </div>
                  <button v-else type="button" class="ws-chip ws-ghost" @click="emit('addWorkspace')">
                    <Icon name="folder-plus" />
                    <span>{{ t('conversation.pickFolder') }}</span>
                  </button>
                </div>
              </template>
            </Composer>
            <!-- Backdrop must live outside the composer card (container-type
                 captures position:fixed). -->
            <div v-if="wsPickOpen" class="ws-backdrop" @click="wsPickOpen = false" />
            <WorkspaceRecentSessions
              v-if="showWorkspaceHome && (recentSessions?.length ?? 0) > 0"
              :sessions="recentSessions ?? []"
              @select-session="(id) => emit('selectSession', id)"
              @open-session-admin="emit('openSessionAdmin', activeWorkspaceId ?? undefined)"
            />
            <div class="empty-spacer" />
          </template>
          <template v-else>
            <ChatPane
              ref="chatPaneRef"
              :key="fileReloadKey ?? 'no-session'"
              :turns="turns"
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
              :undo-hint-turn-id="visibleUndoHintTurnId"
              :interrupted-turn-id="interruptedTurnId"
              :turn-failed="turnFailed"
              :turn-error="turnError ?? null"
              :turn-retry="turnRetry ?? null"
              @resume-turn="handleResumeTurn"
              @open-file="emit('openFile', $event)"
              @open-media="emit('openMedia', $event)"
              @open-turn-diff="emit('openTurnDiff', $event)"
              @copy-conversation-copied="handleCopyConversationCopied"
              @open-compaction="emit('openCompaction', $event)"
              @open-agent="emit('openAgent', $event)"
              @edit-message="handleEditMessage"
              @armed-undo="executeEscUndo"
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
        :working="working"
        :starting="starting"
        :queued="queued"
        :search-files="searchFiles"
        :upload-image="uploadImage"
        :status="status"
        :thinking="thinking"
        :plan-mode="planMode"
        :plan-armed="planArmed"
        :swarm-mode="swarmMode"
        :goal-mode="goalMode"
        :activation-badges="activationBadges"
        :models="models"
        :auth-ready="authReady"
        :managed-signed-in="managedSignedIn"
        :managed-membership="managedMembership"
        :starred-ids="starredIds"
        :skills="skills"
        :skills-loaded="skillsLoaded"
        :goal="goal"
        :session-plans="sessionPlans"
        :dock-panel="dockPanel"
        :overlay-open="overlayOpen"
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
        :open-file="(target) => emit('openFile', target)"
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
          @open-btw="emit('command', { cmd: '/btw', attachments: [] })"
          @create-goal="emit('createGoal', $event)"
          @focus-goal="focusGoal"
          @compact="emit('compact')"
          @pick-model="emit('pickModel')"
          @select-model="emit('selectModel', $event)"
          @login="emit('login')"
      />
    </div>

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

    <!-- "New messages" pill — only visible when scrolled up and new content
         arrives. Gated on an actual transcript: on the empty state (workspace
         home / classic hero) the same container scrolls once the terminal
         panel squeezes it, and a "latest messages" pill is meaningless there. -->
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

    <!-- Undone toast: undo confirmation -->
    <Transition name="undo-toast">
      <div
        v-if="undoneToastVisible"
        class="undo-toast"
        role="status"
        aria-live="polite"
      >
        <span class="undo-toast-text">{{ t('conversation.undone') }}</span>
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

/* Invisible window-drag band for the empty-composer state (no ChatHeader).
   Only macOS desktop honours app-region; elsewhere this is a dead element
   with no visual or hit-test impact beyond the band's rect. */
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

/* Floating terminal toggle for the empty-composer state (desktop-only): same
   icon-button geometry and open-state language as the ChatHeader control it
   stands in for; top-right, mirroring the floating sidebar toggle's slot. */
.empty-terminal-btn {
  position: absolute;
  top: var(--space-3);
  right: var(--space-4);
  z-index: var(--z-sticky);
  width: var(--space-6);
  height: var(--space-6);
  border-radius: var(--radius-sm);
  -webkit-app-region: no-drag;
}
.empty-terminal-btn :deep(svg) { width: var(--p-ic-sm); height: var(--p-ic-sm); }
.empty-terminal-btn.open { background: var(--color-well); color: var(--color-text); }

.panes {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* Keep the visible message stable while the user browses history. Bottom
     following and history prepend use explicit scroll writes, so they opt out. */
  overflow-anchor: auto;
  scrollbar-gutter: stable;
}

/* Overlay-style scrollbar: the global 6px thumb (style.css) is transparent
   here until the pane is actually scrolled (.scrolling), then lingers ~0.9s
   and fades back out. scrollbar-gutter: stable above already reserves the
   strip, so the thumb's appearance never shifts the reading column. Width
   matches the sidebar's 4px bar. */
.panes::-webkit-scrollbar {
  width: 4px;
}
.panes::-webkit-scrollbar-thumb {
  background: transparent;
  transition: background var(--duration-base) var(--ease-out);
}
.panes.scrolling::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text) 12%, transparent);
}
.panes.scrolling::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--color-text) 25%, transparent);
}

/* Session-switch settle curtain (see beginSessionSettle): hide the freshly
   remounted transcript until the initial scroll position has painted. The
   loading spinner stays visible; visibility (not display) keeps the geometry
   measurable for the follow/restore math. */
.panes.session-settling .chat > *:not(.chat-loading) {
  visibility: hidden;
}

.panes.is-following,

.panes.history-prepending,
/* While a row pin owns scrollTop, native anchoring must not join in (the
   follow — and its is-following class — is off for the pin's duration). */
.panes.is-pinned {
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
  box-sizing: border-box;
  padding-bottom: var(--chat-dock-height, 0px);
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
/* The Rive doodle takes the title's slot in the empty-session hero; the text
   fallback inside it keeps the layout identical until the runtime is ready. */
.empty-doodle {
  width: min(340px, 62vw);
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
/* Upgrade guidance banner between the empty-session hint and the composer,
   after the design-system Banner(info) recipe: accent-soft fill, accent-bd
   hairline, accent leading icon. The horizontal inset mirrors .composer's own
   padding so the two align. */
.upgrade-banner {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0 var(--dock-inline-right, 16px) var(--space-2) var(--dock-inline-left, 16px);
  padding: var(--space-2) var(--space-3);
  border: 0.5px solid var(--color-accent-bd);
  border-radius: var(--radius-xl);
  background: var(--color-accent-soft);
}
.upgrade-banner-icon {
  flex: none;
  color: var(--color-accent);
}
.upgrade-banner-text {
  flex: 1;
  min-width: 0;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text);
}
.upgrade-banner-cta {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-accent);
  cursor: pointer;
}
.upgrade-banner-cta:hover {
  color: var(--color-accent-hover);
}
/* Attachment card tucked --space-4 under the complete composer card; the
   card is raised so the attachment always paints behind it. */
.empty-composer :deep(.composer-card) { position: relative; z-index: var(--z-sticky); }
/* Landing textarea rests at three lines; the :not(.expanded) guard leaves the
   expanded editor's own 70vh bounds in charge. */
.empty-composer:not(.expanded) :deep(.ph) { min-height: 3lh; }
.ws-bar {
  margin-top: calc(-1 * var(--space-4));
  padding: calc(var(--space-4) + var(--space-2)) var(--space-2) var(--space-2);
  background: color-mix(in srgb, var(--color-hover) 60%, transparent);
  border-radius: 0 0 var(--radius-2xl) var(--radius-2xl);
  font-family: var(--font-ui);
}
.ws-anchor {
  position: relative;
}

.ws-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 100%;
  padding: var(--space-2) var(--space-3);
  background: none;
  border: none;
  border-radius: var(--radius-full);
  color: var(--color-text-muted);
  font-family: inherit;
  font-size: var(--ui-font-size-sm);
  cursor: pointer;
  transition: background var(--duration-base) var(--ease-out);
}
.ws-chip:hover,
.ws-chip.open {
  background: var(--color-selected);
  color: var(--color-text);
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

.ws-chip.ws-ghost { color: var(--color-text-muted); }
.ws-chip.ws-ghost:hover { color: var(--color-text); }

.ws-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-sticky);
}

.ws-panel {
  position: absolute;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  left: 0;
  top: calc(100% + var(--space-1));
  z-index: var(--z-dropdown);
  width: max-content;
  min-width: min(calc(var(--space-8) * 8), 100%);
  max-width: 100%;
  max-height: calc(var(--space-8) * 10);
  overflow: hidden auto;
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: 0.5px solid var(--color-line);
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

.ws-caption {
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-faint);
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
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  cursor: pointer;
  font-family: var(--font-ui);
}
.ws-row > .kw-icon { flex: none; color: var(--muted); }
.ws-row:hover { background: var(--color-hover); }
.ws-row.on { background: var(--color-selected); }
.ws-row:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
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
  border-radius: var(--radius-sm);
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
  border: 0.5px solid var(--line);
  background: var(--panel);
  color: var(--color-text);
  font-size: var(--text-xs);
  font-weight: var(--weight-ui-strong);
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  /* Sits just above the dock, which owns a veil over the transcript. The pill
     joins the dock's sticky layer and, coming after the dock in DOM order,
     paints above the veil. ChatDock temporarily moves to --z-dropdown while
     a composer popup or a dock work panel is open, so those still paint
     above this pill. */
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

.undo-toast {
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
.undo-toast-text {
  display: flex;
  align-items: center;
  gap: 8px;
}
.undo-toast-enter-active,
.undo-toast-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.undo-toast-enter-from,
.undo-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-6px);
}

.con { background: var(--bg); }
.newmsg-pill { font-family: var(--sans); }
</style>
