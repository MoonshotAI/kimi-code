<!-- apps/kimi-web/src/components/chat/ChatPane.vue -->
<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatTurn, ApprovalBlock, FilePreviewRequest, ToolMedia, QueuedPromptView, TurnAttachment, UIQuestion } from '../../types';
import ToolCall from './ToolCall.vue';
import ActivityRun from './ActivityRun.vue';
import TurnFold from './TurnFold.vue';
import TurnFilesSummary from './TurnFilesSummary.vue';
import NotificationCard from './NotificationCard.vue';
import { Markdown } from '@moonshot-ai/web-markdown';
import ThinkingBlock from './ThinkingBlock.vue';
import ActivityNotice from './ActivityNotice.vue';
import CronNotice from './CronNotice.vue';
import MessageTime from './MessageTime.vue';
import AuthMedia from './AuthMedia.vue';
import MediaLightbox from './MediaLightbox.vue';
import MediaThumb from './MediaThumb.vue';
import AttachmentChip from './AttachmentChip.vue';
import WorkingIndicator from './WorkingIndicator.vue';
import { Icon, Kbd, Spinner, Button } from '@moonshot-ai/web-ui';
import { useConfirmDialog } from '../../composables/useConfirmDialog';
import { copyTextToClipboard } from '../../lib/clipboard';
import { openFileAttachment } from '../../lib/openFileAttachment';
import {
  formatDuration,
  formatTokens,
  isoMs,
  renderBlockKey,
  splitAssistantFold,
  turnActivitySeedMs,
  turnBlocks,
  turnFileChangesCached,
  turnToMarkdown,
  turnVisibleFinalText,
} from '../chatTurnRendering';
import type { AssistantFold, TurnFileChange } from '../chatTurnRendering';

const { t } = useI18n();
const { confirm } = useConfirmDialog();

onUnmounted(() => {
  if (copiedTimer !== null) {
    clearTimeout(copiedTimer);
    copiedTimer = null;
  }
  if (copiedConversationTimer !== null) {
    clearTimeout(copiedConversationTimer);
    copiedConversationTimer = null;
  }
  if (undoFallbackTimer !== null) {
    clearTimeout(undoFallbackTimer);
    undoFallbackTimer = null;
  }
  if (unsupportedOpenTimer !== null) {
    clearTimeout(unsupportedOpenTimer);
    unsupportedOpenTimer = null;
  }
});

const props = withDefaults(
  defineProps<{
    turns: ChatTurn[];
    /** Active session's working directory — used to display a turn's file
        changes as workspace-relative paths (files outside it stay absolute). */
    cwd?: string;
    /** False where nothing handles the summary's row action (the BTW side
        chat) — its file rows render as plain text instead of links. */
    turnFilesInteractive?: boolean;
    approvals?: { approvalId: string; block: ApprovalBlock; agentName?: string; toolCallId?: string }[];
    /** Pending questions for the session (AskUserQuestion awaiting an answer) —
        a tool tail waiting on one reads as parked, not streaming. */
    questions?: UIQuestion[];
    /**
     * True while the MAIN agent has a turn in flight (not merely "session
     * busy" — background subagents and BTW side chats don't set this). Marks
     * the last assistant turn as actively streaming so its Markdown animates
     * the smooth typewriter/fade reveal; all other turns render statically.
     */
    turnActive?: boolean;
    /**
     * The main conversation has an unfinished prompt (submitted, or a main
     * turn in flight). Renders the working indicator at the end of the
     * transcript and gates "edit & resend" on the last user message.
     */
    working?: boolean;
    /**
     * True while the session turns are being fetched (e.g. after switching to
     * a historical session). Shows a lightweight loading placeholder instead of
     * the empty-conversation state.
     */
    sessionLoading?: boolean;
    /**
     * Live compaction state of the session: non-null while the daemon rewrites
     * history, rendered as a body-sized "Compacting context…" activity notice.
     * Completion is a persistent divider turn (role 'compaction') in `turns`.
     */
    compaction?: { status: 'running' } | null;
    /**
     * True when there are older messages available above the current viewport.
     */
    hasMoreMessages?: boolean;
    /**
     * True while older messages are being fetched (rendered at the top of the pane).
     */
    loadingMore?: boolean;
    /**
     * True when the last older-message fetch failed; blocks automatic sentinel retries.
     */
    loadingMoreError?: boolean;
    /**
     * True when the conversation pane is currently following the bottom (auto-scroll).
     * Used to prevent the top sentinel from eagerly loading older messages on open.
     */
    isFollowing?: boolean;
    /** Suppress main-conversation mutation affordances in transcript-only views. */
    readOnly?: boolean;
    /**
     * Pending user messages queued while the session is busy. Rendered inline
     * at the tail of the transcript (after the running turn) — click to edit,
     * × to remove, drag the grip to reorder.
     */
    queued?: QueuedPromptView[];
    /**
     * User turn armed for "press Escape again to undo" (set by ConversationPane
     * right after an Esc abort). The undo affordance on this turn expands into
     * the hint label; clicking it undoes without the confirm step.
     */
    undoHintTurnId?: string | null;
    /**
     * Assistant turn whose run was manually stopped (last turn ended
     * 'cancelled') — renders a small "Stopped" marker at its tail.
     */
    interruptedTurnId?: string | null;
    /**
     * The session's latest main turn ended 'failed' (model request error) and
     * the session has been idle since — renders a persistent failed-turn card
     * with a resume action at the tail of the transcript.
     */
    turnFailed?: boolean;
    /** The failed turn's wire error: the detail line (message), the
        diagnostics meta (code / HTTP status / request id), and the card's
        title kind (e.g. 'loop.max_steps_exceeded' is not a model failure). */
    turnError?: { code?: string; message?: string; statusCode?: number; requestId?: string } | null;
    /** Live step-retry state of the running main turn (provider failure
        backoff) — the working indicator narrates the retry instead of
        looking stuck. */
    turnRetry?: { nextAttempt: number; maxAttempts: number } | null;
    /**
     * @deprecated No longer used — Composer is rendered by ConversationPane.
     */
  }>(),
  {
    approvals: () => [],
    questions: () => [],
    turnFilesInteractive: true,
    turnActive: false,
    working: false,
    compaction: null,
    hasMoreMessages: false,
    loadingMore: false,
    loadingMoreError: false,
    isFollowing: false,
    readOnly: false,
    queued: () => [],
    undoHintTurnId: null,
    interruptedTurnId: null,
    turnFailed: false,
    turnError: null,
    turnRetry: null,
  },
);

// Top sentinel for lazy-loading older messages. Visible when there are older
// messages or while a page is loading; the IntersectionObserver fires as soon
// as the user scrolls (or pans) near the top of the transcript.
const topSentinelRef = ref<HTMLElement | null>(null);
let topSentinelObserver: IntersectionObserver | null = null;

function observeTopSentinel(): void {
  if (!topSentinelRef.value || typeof IntersectionObserver === 'undefined') return;
  topSentinelObserver?.disconnect();
  topSentinelObserver = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      // Only trigger when the user has intentionally scrolled away from the
      // bottom (isFollowing=false) and the initial snapshot is no longer loading.
      if (
        entry?.isIntersecting &&
        props.hasMoreMessages &&
        !props.loadingMore &&
        !props.loadingMoreError &&
        !props.sessionLoading &&
        !props.isFollowing
      ) {
        emit('loadOlderMessages');
      }
    },
    { root: null, rootMargin: '200px 0px 0px 0px', threshold: 0 },
  );
  topSentinelObserver.observe(topSentinelRef.value);
}

onMounted(observeTopSentinel);
onUnmounted(() => {
  topSentinelObserver?.disconnect();
  topSentinelObserver = null;
});
watch(
  () => [props.hasMoreMessages, props.loadingMore, props.loadingMoreError],
  () => {
    // Re-attach the observer after a load so that a still-visible sentinel
    // (e.g. the page was not tall enough to scroll) triggers another page.
    // Wait for the next render tick because the sentinel is rendered by v-if
    // and may not exist when this watcher first fires.
    void nextTick().then(observeTopSentinel);
  },
);

// The id of the turn that is actively streaming: the last assistant turn while
// the main turn is in flight. Its Markdown renders with `streaming`
// (final=false); every other turn renders statically.
const streamingTurnId = computed<string | null>(() => {
  if (!props.turnActive || props.turns.length === 0) return null;
  const last = props.turns.at(-1)!;
  return last.role === 'assistant' ? last.id : null;
});

// Per-turn file-change summaries, derived once per turns array instead of
// twice per turn in the template, and memoized per turn across turns-array
// rebuilds via turnFileChangesCached (the turns array is rebuilt on every
// streamed event; the LCS diffs behind the stats must not be re-synthesized
// for every old turn each time). Keyed by turn id; turns without changes are
// simply absent.
const turnFileChangesById = computed(() => {
  const map = new Map<string, ReturnType<typeof turnFileChangesCached>>();
  for (const turn of props.turns) {
    if (turn.role !== 'assistant' || turn.id === streamingTurnId.value) continue;
    const changes = turnFileChangesCached(turn);
    if (changes.length > 0) map.set(turn.id, changes);
  }
  return map;
});

// Trailing working indicator: shown while the main conversation has an
// unfinished prompt. `working` is the union of the optimistic submit window
// and the main turn's liveness (restored from the snapshot's inFlightTurn
// after a refresh); background agents and BTW side chats never show here —
// the indicator belongs to the main conversation only.
const showWorking = computed(() => props.working);

// Phase label: "requesting" until the turn produces its first output. The
// pending assistant bubble is created at turn.step.started — before any
// content — so the phase keys off output (text / thinking / tools), not the
// turn's existence.
const workingLabel = computed(() => {
  // A step backing off for a retry (provider 429/5xx…) keeps the turn alive —
  // say so instead of a generic "working" that reads as a hang.
  const retry = props.turnRetry;
  if (retry !== null && retry !== undefined) {
    return t('conversation.workingRetry', { n: retry.nextAttempt, max: retry.maxAttempts });
  }
  const last = props.turns.at(-1);
  const hasOutput =
    last?.role === 'assistant' &&
    (last.text.trim().length > 0 ||
      (last.thinking?.trim().length ?? 0) > 0 ||
      (last.tools?.length ?? 0) > 0);
  return t(hasOutput ? 'conversation.working' : 'conversation.requesting');
});

// The card title follows the failure kind: a step-limit stop is not a
// model-request failure. The code is the wire contract (kap-server
// KimiErrorCode); everything else keeps the generic model-failure copy.
const turnFailedTitle = computed(() =>
  props.turnError?.code === 'loop.max_steps_exceeded'
    ? t('conversation.turnFailedMaxSteps')
    : t('conversation.turnFailed'),
);

// Diagnostics meta row — the same facts the error toast used to carry, kept
// on the persistent card so foreground failures stay troubleshootable.
const turnErrorMeta = computed(() => {
  const error = props.turnError;
  if (!error) return '';
  const parts: string[] = [];
  if (error.code !== undefined && error.code.length > 0) parts.push(error.code);
  if (error.statusCode !== undefined) parts.push(`HTTP ${error.statusCode}`);
  if (error.requestId !== undefined && error.requestId.length > 0) parts.push(error.requestId);
  return parts.join(' · ');
});

const emit = defineEmits<{
  openFile: [target: FilePreviewRequest];
  openMedia: [media: ToolMedia];
  /** Show one turn's diff for one file (from its file-change summary card). */
  openTurnDiff: [change: TurnFileChange];
  copyConversationCopied: [];
  /** Show a compaction divider's summary text in the right-side panel. */
  openCompaction: [target: { turnId: string }];
  /** Show a subagent's live detail in the right-side panel (keyed by the
   *  spawning `Agent` tool-call id). */
  openAgent: [toolCallId: string];
  /** Edit + resend the last user message (parent undoes, then refills composer). */
  editMessage: [payload: { text: string; attachments?: TurnAttachment[] }];
  /** The armed "press Esc again" affordance was clicked — same as the second
   *  Esc, routed through the parent's guarded executor. */
  armedUndo: [turnId: string];
  /** Fetch the next older page of messages (triggered by top sentinel visibility or click). */
  loadOlderMessages: [];
  /** Remove a queued message by index. */
  unqueue: [index: number];
  /** Load a queued message back into the composer for editing (and dequeue it). */
  editQueued: [index: number];
  /** Drag-to-reorder a queued message within the active session's queue. */
  reorderQueue: [payload: { from: number; to: number }];
  /** The failed-turn card's continue action — the parent routes it through the
   *  normal submit path as a short "continue" prompt. */
  resumeTurn: [];
}>();

// ---- Inline queue (pending messages while running) ------------------------
// Edit/remove are one-click; reorder is HTML5 drag-and-drop initiated from the
// grip handle (the body stays a click-to-edit button).
const dragFrom = ref<number | null>(null);
const dragOver = ref<{ index: number; position: 'before' | 'after' } | null>(null);

function hasAttachments(item: QueuedPromptView): boolean {
  return (item.attachments?.length ?? 0) > 0;
}

function onQueueEdit(index: number): void {
  // Image/video attachments round-trip through the composer now (the composer
  // can hold fileIds), so a queued prompt can be loaded back for edit whether or
  // not it carries media.
  emit('editQueued', index);
}

function onQueueDragStart(index: number, event: DragEvent): void {
  dragFrom.value = index;
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(index));
  // Use the whole row as the drag image instead of just the grip handle.
  const row = (event.currentTarget as HTMLElement | null)?.closest<HTMLElement>('.q-turn');
  if (row) event.dataTransfer.setDragImage(row, 24, 24);
}

function onQueueDragOver(index: number, event: DragEvent): void {
  if (dragFrom.value === null) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  dragOver.value = { index, position };
}

function onQueueDrop(index: number, event: DragEvent): void {
  event.preventDefault();
  const from = dragFrom.value;
  const position = dragOver.value?.position ?? 'before';
  dragFrom.value = null;
  dragOver.value = null;
  if (from === null) return;
  // Convert the "before/after target row" into a final insertion index,
  // adjusting for the source row being removed first on downward moves.
  let to = position === 'before' ? index : index + 1;
  if (from < to) to -= 1;
  if (from === to) return;
  emit('reorderQueue', { from, to });
}

function onQueueDragEnd(): void {
  dragFrom.value = null;
  dragOver.value = null;
}

// Id of the most recent user turn — the only one offered an "edit & resend"
// affordance (undo only rewinds the latest exchange). When the latest exchange
// is a goal-continuation turn there is NO user-driven latest exchange: undo
// would rewind the hidden trigger turn while the composer gets the older user
// text back, so the affordance is suppressed entirely.
const lastUserTurnId = computed<string | null>(() => {
  for (let i = props.turns.length - 1; i >= 0; i--) {
    const turn = props.turns[i]!;
    if (turn.goalContinuation) return null;
    if (turn.role === 'user') return turn.id;
  }
  return null;
});

/** Whether to offer "edit & resend" on this turn: the latest user message, only
    while the conversation has nothing unfinished and it isn't a slash activation. */
function canEditTurn(turn: ChatTurn): boolean {
  return (
    !props.readOnly &&
    turn.role === 'user' &&
    turn.id === lastUserTurnId.value &&
    !props.working &&
    !turn.skillActivation &&
    !turn.pluginCommand
  );
}

/** Divider label: "Context compacted"/"auto-compacted" + optional token stats. */
function compactionDividerLabel(turn: ChatTurn): string {
  const c = turn.compaction;
  const base =
    c?.trigger === 'auto' ? t('conversation.compactedAuto') : t('conversation.compactedPlain');
  if (typeof c?.tokensBefore === 'number' && typeof c?.tokensAfter === 'number') {
    return (
      base +
      t('conversation.compactedTokens', {
        before: formatTokens(c.tokensBefore),
        after: formatTokens(c.tokensAfter),
      })
    );
  }
  return base;
}

// Per-turn copy button state (keyed by turn id)
const copiedTurn = ref<string | null>(null);

/** The assistant footer's duration label; '' (no stamp or a sub-second span)
    hides both the label and an otherwise-empty footer. */
function turnDurationLabel(turn: ChatTurn): string {
  return turn.durationMs === undefined ? '' : formatDuration(turn.durationMs);
}

// Undo in-flight guard (keyed by turn id) — set while the server rewinds the
// turn so a second undo can't fire until the first one settles.
const undoingTurnId = ref<string | null>(null);
// Fallback that releases the undoing state if the server rewind never removes
// the turn (e.g. the undo failed). Without it the guard in confirmEditMessage
// would block any further undo.
let undoFallbackTimer: ReturnType<typeof setTimeout> | null = null;
const UNDO_FALLBACK_MS = 2500;

async function onUndo(turn: ChatTurn): Promise<void> {
  if (
    await confirm({
      title: t('conversation.undo'),
      message: t('conversation.undoConfirm'),
      variant: 'primary',
    })
  ) {
    confirmEditMessage(turn);
  }
}

function confirmEditMessage(turn: ChatTurn): void {
  if (undoingTurnId.value !== null) return;
  undoingTurnId.value = turn.id;
  emit('editMessage', { text: turn.text, attachments: turn.attachments });
  // Fallback: if the server rewind never removes the turn (e.g. it failed),
  // release the guard so the user can retry.
  undoFallbackTimer = setTimeout(() => {
    undoFallbackTimer = null;
    undoingTurnId.value = null;
  }, UNDO_FALLBACK_MS);
}

// Release the undoing guard once the server rewind has actually removed the turn
// from the list (post-render, so the element is already gone).
watch(
  () => props.turns,
  (turns) => {
    if (undoingTurnId.value === null) return;
    if (turns.some((t) => t.id === undoingTurnId.value)) return;
    undoingTurnId.value = null;
    if (undoFallbackTimer !== null) {
      clearTimeout(undoFallbackTimer);
      undoFallbackTimer = null;
    }
  },
  { flush: 'post' },
);

// Copy-whole-conversation state
const copiedConversation = ref(false);
let copiedConversationTimer: ReturnType<typeof setTimeout> | null = null;

/** Convert the entire conversation to Markdown and copy to clipboard. */
function copyConversation(): void {
  if (props.turns.length === 0) return;
  const lines: string[] = [];
  for (const turn of props.turns) {
    if (turn.role === 'compaction' || turn.role === 'cron') continue; // dividers / cron notices don't copy
    const roleLabel = turn.role === 'user' ? 'User' : 'Assistant';
    const content = turnToMarkdown(turn);
    if (content.trim()) {
      lines.push(`**${roleLabel}**\n\n${content}`);
    }
  }
  const markdown = lines.join('\n\n---\n\n');
  void copyTextToClipboard(markdown).then((ok) => {
    if (!ok) return;
    copiedConversation.value = true;
    emit('copyConversationCopied');
    if (copiedConversationTimer !== null) clearTimeout(copiedConversationTimer);
    copiedConversationTimer = setTimeout(() => {
      copiedConversationTimer = null;
      copiedConversation.value = false;
    }, 2000);
  }).catch(() => {/* ignore */});
}

function assistantRunEndingAt(index: number): ChatTurn[] {
  const run: ChatTurn[] = [];
  for (let i = index; i >= 0; i--) {
    const turn = props.turns[i];
    if (!turn || turn.role !== 'assistant') break;
    run.unshift(turn);
  }
  return run;
}

/** The run's copyable final answer: only the text still visible after the
    turn-level fold (interim texts folded away must not be copied). */
function assistantRunFinalText(index: number): string {
  return assistantRunEndingAt(index)
    .map((t) => turnVisibleFinalText(t))
    .filter(Boolean)
    .join('\n\n');
}

function finalSummaryText(): string {
  for (let i = props.turns.length - 1; i >= 0; i -= 1) {
    if (props.turns[i]?.role === 'assistant') return assistantRunFinalText(i);
  }
  return '';
}

function copyFinalSummary(): void {
  const text = finalSummaryText();
  if (!text.trim()) return;
  void copyTextToClipboard(text).then((ok) => {
    if (!ok) return;
    copiedConversation.value = true;
    emit('copyConversationCopied');
    if (copiedConversationTimer !== null) clearTimeout(copiedConversationTimer);
    copiedConversationTimer = setTimeout(() => {
      copiedConversationTimer = null;
      copiedConversation.value = false;
    }, 2000);
  }).catch(() => {/* ignore */});
}

defineExpose({ copyConversation, copyFinalSummary });

function isAssistantRunEnd(index: number): boolean {
  const turn = props.turns[index];
  if (!turn || turn.role !== 'assistant') return false;
  const next = props.turns[index + 1];
  return !next || next.role !== 'assistant';
}

// One shared timer: copying B within 1.4s of copying A must not let A's stale
// timer hide B's checkmark early. Cleared on unmount.
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
function copyAssistantRun(index: number): void {
  const turn = props.turns[index];
  if (!turn) return;
  const text = assistantRunFinalText(index);
  if (!text.trim()) return;
  void copyTextToClipboard(text).then((ok) => {
    if (!ok) return;
    copiedTurn.value = turn.id;
    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedTimer = null;
      copiedTurn.value = null;
    }, 1400);
  }).catch(() => {/* ignore */});
}

function copyUserMessage(turn: ChatTurn): void {
  const text = turn.text;
  if (!text.trim()) return;
  void copyTextToClipboard(text).then((ok) => {
    if (!ok) return;
    copiedTurn.value = turn.id;
    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedTimer = null;
      copiedTurn.value = null;
    }, 1400);
  }).catch(() => {/* ignore */});
}

// Overlong user text clamps to a fixed line count with a fade-out tail and an
// expand/collapse toggle. Overflow is measured, never guessed from text length.
const USER_TEXT_CLAMP_LINES = 10; // must match the .is-clamped CSS max-height

const clampableUserTurns = reactive(new Set<string>());
const expandedUserTurns = reactive(new Set<string>());

const userTextEls = new Map<string, HTMLElement>();
const userTextTurnIds = new WeakMap<HTMLElement, string>();
const pinScroll = inject<(el: HTMLElement, ms?: number) => void>('pinScroll', () => {});

const userTextObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const el = entry.target as HTMLElement;
    const turnId = userTextTurnIds.get(el);
    if (turnId !== undefined) measureUserText(turnId, el);
  }
});
onUnmounted(() => userTextObserver.disconnect());

function measureUserText(turnId: string, el: HTMLElement): void {
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
  // Trailing blank lines render empty and must not count toward the clamp.
  const text = el.textContent ?? '';
  const trailingBlanks = text.match(/\n+$/)?.[0].length ?? 0;
  const contentHeight = el.scrollHeight - Math.max(0, trailingBlanks - 1) * lineHeight;
  if (contentHeight > lineHeight * USER_TEXT_CLAMP_LINES + 1) {
    clampableUserTurns.add(turnId);
  } else {
    clampableUserTurns.delete(turnId);
  }
}

// Inline ref callbacks fire null→el on every re-render: bail on both so a
// streaming transcript never re-measures settled bubbles.
function registerUserTextEl(turnId: string, el: unknown): void {
  if (!(el instanceof HTMLElement) || userTextEls.get(turnId) === el) return;
  const prev = userTextEls.get(turnId);
  if (prev !== undefined) userTextObserver.unobserve(prev);
  userTextEls.set(turnId, el);
  userTextTurnIds.set(el, turnId);
  userTextObserver.observe(el);
  measureUserText(turnId, el);
}

// Queue clamp state keys off the entry id so it follows the prompt across
// reorder/remove, not the slot.
function queueClampId(item: QueuedPromptView): string {
  return `queue:${item.id}`;
}

// Turns (or queue entries) removed for real leave stale clamp state — prune it.
watch(
  [() => props.turns, () => props.queued],
  () => {
    const ids = new Set(props.turns.map((t) => t.id));
    for (const item of props.queued) ids.add(queueClampId(item));
    for (const [id, el] of userTextEls) {
      if (ids.has(id)) continue;
      userTextObserver.unobserve(el);
      userTextEls.delete(id);
      clampableUserTurns.delete(id);
      expandedUserTurns.delete(id);
    }
  },
);

// Clampable bubble text: skill/plugin args when a command card replaced the
// raw input, otherwise the user's verbatim text.
function userTextContent(turn: ChatTurn): string | null {
  if (turn.skillActivation) return turn.skillActivation.args || null;
  if (turn.pluginCommand) return turn.pluginCommand.args || null;
  return turn.text || null;
}

function isCommandArgs(turn: ChatTurn): boolean {
  return turn.skillActivation !== undefined || turn.pluginCommand !== undefined;
}

function isUserTextClamped(turnId: string): boolean {
  return clampableUserTurns.has(turnId) && !expandedUserTurns.has(turnId);
}

function toggleUserText(turnId: string, event: MouseEvent): void {
  const collapsing = expandedUserTurns.has(turnId);
  // Collapsing removes height above the toggle: anchor it BEFORE the state
  // change so the pin loop absorbs the jump. Expanding only grows downward.
  if (collapsing && event.currentTarget instanceof HTMLElement) {
    pinScroll(event.currentTarget);
  }
  if (collapsing) expandedUserTurns.delete(turnId);
  else expandedUserTurns.add(turnId);
}

/** User-bubble attachments split two ways: images/videos render as MediaThumb
    rounded thumbnails (the same component the composer strip uses); every
    other kind keeps the AttachmentChip row. */
type MediaTurnAttachment = TurnAttachment & { kind: 'image' | 'video' };

function isMediaAttachment(att: TurnAttachment): att is MediaTurnAttachment {
  return att.kind === 'image' || att.kind === 'video';
}

function mediaAttachments(turn: ChatTurn): MediaTurnAttachment[] {
  return (turn.attachments ?? []).filter(isMediaAttachment);
}

function fileAttachments(turn: ChatTurn): TurnAttachment[] {
  return (turn.attachments ?? []).filter((att) => !isMediaAttachment(att));
}

function userAttachmentMedia(att: TurnAttachment): ToolMedia {
  // User-uploaded media carries no path/mime metadata; the preview panel falls
  // back to a generic label and sniffs the mime from the URL when needed. When
  // a fileId is present the preview fetches the bytes with auth (a bare
  // getFileUrl src 401s under daemon auth).
  return { kind: att.kind === 'video' ? 'video' : 'image', url: att.url, path: att.name, fileId: att.fileId };
}

// Transient "can't open this type" hint after clicking a file chip of a
// non-previewable type. Mirrors the copiedTurn timer pattern; cleared on unmount.
const unsupportedOpenName = ref<string | null>(null);
let unsupportedOpenTimer: ReturnType<typeof setTimeout> | null = null;

// Floating media preview for user-bubble media attachments (image/video).
// Replaces the right-side detail panel for user uploads — and gives VIDEOS a
// working preview at all (openMediaPreview ignores non-images, so chip clicks
// on videos used to be dead).
const mediaLightbox = ref<ToolMedia | null>(null);
/** The clicked thumbnail <img> — the image preview's zoom origin (PhotoSwipe). */
const mediaLightboxImg = ref<HTMLImageElement | null>(null);

function onAttachmentClick(att: TurnAttachment, img?: HTMLImageElement | null): void {
  if (att.kind === 'image' || att.kind === 'video') {
    mediaLightboxImg.value = img ?? null;
    mediaLightbox.value = userAttachmentMedia(att);
    return;
  }
  // Generic files open in a new tab, but only whitelisted inert types —
  // anything else gets the unsupported hint instead of an active-document
  // preview (see openFileAttachment).
  if (att.fileId === undefined) return;
  void openFileAttachment(att.fileId, att.name, att.mediaType).then((result) => {
    if (result !== 'unsupported') return;
    unsupportedOpenName.value = att.name ?? att.fileId ?? '';
    if (unsupportedOpenTimer !== null) clearTimeout(unsupportedOpenTimer);
    unsupportedOpenTimer = setTimeout(() => {
      unsupportedOpenTimer = null;
      unsupportedOpenName.value = null;
    }, 2400);
  });
}

function isStreamingRenderBlock(turn: ChatTurn, block: { sourceIndex: number; kind?: string; durationMs?: number }): boolean {
  if (turn.id !== streamingTurnId.value) return false;
  // A settled thinking block is done even while still the last block — the
  // turn is parked on an approval/question (see settleThinkingOnUserInteraction).
  if (block.kind === 'thinking' && block.durationMs !== undefined) return false;
  return block.sourceIndex === turnBlocks(turn).length - 1;
}

/** An activity run streams while it is the live tail of the streaming turn:
    its last item sits on the turn's last block, so further steps append into
    this same run. Once a text block (or anything else) takes the tail, the
    run settles and folds itself back. */
function isStreamingActivityRun(turn: ChatTurn, block: { items: { sourceIndex: number; kind?: string; durationMs?: number }[] }): boolean {
  if (turn.id !== streamingTurnId.value) return false;
  const last = block.items.at(-1);
  // A settled thinking tail means the turn parked on an approval/question.
  if (last?.kind === 'thinking' && last.durationMs !== undefined) return false;
  return last !== undefined && last.sourceIndex === turnBlocks(turn).length - 1;
}

/** Turn-level fold split (see chatTurnRendering.splitAssistantFold): everything
    before the turn's final text block folds into a TurnFold row; the final
    text and any trailing blocks keep their normal rendering. */
const EMPTY_FOLD: AssistantFold = { folded: [], visible: [] };
function assistantFold(turn: ChatTurn): AssistantFold {
  if (turn.role !== 'assistant') return EMPTY_FOLD;
  return splitAssistantFold(turn);
}

/** The sourceIndex of the turn's live tail block while it streams; null for
    every settled turn (the TurnFold's streaming vocabulary). A settled
    thinking tail — or a tool tail awaiting a pending approval/question —
    means the turn parked on user interaction: the fold treats the turn as
    settled (row shown, clock frozen) until the stream moves on. */
function streamingTailIndex(turn: ChatTurn): number | null {
  if (turn.id !== streamingTurnId.value) return null;
  const blocks = turnBlocks(turn);
  const last = blocks.at(-1);
  if (last?.kind === 'thinking' && last.durationMs !== undefined) return null;
  if (last?.kind === 'tool' && last.tool.status === 'running') {
    const id = last.tool.id;
    if (props.approvals?.some((a) => a.toolCallId === id)) return null;
    if (props.questions?.some((q) => q.toolCallId === id)) return null;
  }
  return blocks.length - 1;
}

// NOTE: the turn-summary line ("已调用 N 个工具…") was removed in f9417af. If it
// comes back, rebuild it from turnBlocks() with i18n strings — the old
// implementation lives in git history at f9417af^.
</script>

<template>
  <!-- Chat bubbles: user turns are right-aligned soft-blue bubbles; assistant
       turns are left-aligned plain text with no role/name label, in order:
       thinking → message text → tool cards. -->
  <div class="chat">
    <div v-if="sessionLoading" class="chat-loading">
      <Spinner size="sm" />
      <span class="chat-loading-text">{{ t('conversation.loading') }}</span>
    </div>
    <div v-else-if="turns.length === 0 && (!approvals || approvals.length === 0)" class="chat-empty" />

    <div
      v-if="hasMoreMessages || loadingMore"
      ref="topSentinelRef"
      class="top-sentinel"
      :class="{ 'top-sentinel-loading': loadingMore }"
    >
      <button
        v-if="!loadingMore"
        type="button"
        class="top-sentinel-btn"
        @click="emit('loadOlderMessages')"
      >
        {{ t('conversation.loadOlder') }}
      </button>
      <span v-else class="top-sentinel-text">
        <Spinner size="sm" />
        {{ t('conversation.loadingOlder') }}
      </span>
    </div>

    <template v-for="(turn, ti) in turns" :key="turn.id">
      <!-- User turn → right-aligned soft-blue bubble (undo affordance lives
           outside the bubble with an inline confirm step). -->
      <template v-if="turn.role === 'user'">
        <div class="u-turn">
          <div class="u-bub turn-anchor" :class="{ undoing: undoingTurnId === turn.id }" :data-turn-id="turn.id">
            <!-- Image/video attachments: MediaThumb rounded thumbnails — the
                 same component the composer strip shows while drafting; every
                 other kind keeps the AttachmentChip row. -->
            <div v-if="mediaAttachments(turn).length > 0" class="u-media">
              <MediaThumb
                v-for="(att, ai) in mediaAttachments(turn)"
                :key="ai"
                :kind="att.kind"
                :name="att.name"
                :url="att.url"
                :file-id="att.fileId"
                @activate="onAttachmentClick(att, $event)"
              />
            </div>
            <!-- File attachments keep the chip row -->
            <div v-if="fileAttachments(turn).length > 0" class="u-atts">
              <AttachmentChip
                v-for="(att, ai) in fileAttachments(turn)"
                :key="ai"
                :kind="att.kind"
                :name="att.name"
                :url="att.url"
                :file-id="att.fileId"
                :media-type="att.mediaType"
                :size="att.size"
                @activate="onAttachmentClick(att)"
              />
            </div>
            <!-- Skill activation card (replaces raw XML) -->
            <div v-if="turn.skillActivation" class="skill-act">
              <div class="skill-act-head">
                <span class="skill-act-arrow">▶</span>
                <span>{{ t('conversation.activatedSkill', { name: turn.skillActivation.name }) }}</span>
              </div>
            </div>
            <!-- Plugin command card (replaces expanded body) -->
            <div v-else-if="turn.pluginCommand" class="skill-act">
              <div class="skill-act-head">
                <span class="skill-act-arrow">▶</span>
                <span>/{{ turn.pluginCommand.pluginId }}:{{ turn.pluginCommand.commandName }}</span>
              </div>
            </div>
            <!-- User text — or skill/plugin args when a command card replaced
                 the raw input — verbatim (pre-wrap), never Markdown; skipped
                 when empty. Overlong content clamps with a fade + toggle. -->
            <div
              v-if="userTextContent(turn) !== null"
              class="u-text-wrap"
              :class="{ 'is-clamped': isUserTextClamped(turn.id), 'u-text-wrap-args': isCommandArgs(turn) }"
            >
              <div
                :class="isCommandArgs(turn) ? 'skill-act-args' : 'u-text'"
                :ref="(el) => registerUserTextEl(turn.id, el)"
              >{{ userTextContent(turn) }}</div>
              <button
                v-if="clampableUserTurns.has(turn.id)"
                type="button"
                class="u-text-toggle"
                :aria-expanded="!isUserTextClamped(turn.id)"
                @click="toggleUserText(turn.id, $event)"
              >
                <span>{{
                  isUserTextClamped(turn.id)
                    ? t('conversation.userMessage.expand')
                    : t('conversation.userMessage.collapse')
                }}</span>
                <Icon class="u-text-toggle-car" name="chevron-down" size="sm" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div v-if="turn.createdAt || canEditTurn(turn) || (!readOnly && undoHintTurnId === turn.id)" class="u-meta">
            <div v-if="canEditTurn(turn) || (!readOnly && undoHintTurnId === turn.id)" class="u-edit-wrap" :class="{ undoing: undoingTurnId === turn.id }">
              <!-- Armed after an Esc abort: clicking undoes directly — armed is the confirm step. -->
              <button
                v-if="undoHintTurnId === turn.id"
                type="button"
                class="u-edit u-edit-armed"
                :aria-label="t('conversation.undoTooltip')"
                @click="emit('armedUndo', turn.id)"
              >
                <Icon name="undo" size="sm" />
                <span class="u-edit-hint">
                  {{ t('conversation.escUndoHintPre') }}<Kbd :keys="['Esc']" />{{ t('conversation.escUndoHintPost') }}
                </span>
              </button>
              <button
                v-else
                type="button"
                class="u-edit"
                :aria-label="t('conversation.undoTooltip')"
                @click="onUndo(turn)"
              >
                <Icon name="undo" size="sm" />
              </button>
            </div>
            <button
              v-if="turn.text.trim().length > 0"
              type="button"
              class="u-copy"
              :aria-label="t('filePreview.copy')"
              @click.stop="copyUserMessage(turn)"
            >
              <Icon v-if="copiedTurn !== turn.id" name="copy" size="sm" />
              <Icon v-else name="check" size="sm" />
            </button>
            <MessageTime v-if="turn.createdAt" :time="turn.createdAt" />
          </div>
        </div>
      </template>

      <!-- Compaction divider — prior turns stay untouched; summary opens in
           the right-side panel on click. -->
      <div v-else-if="turn.role === 'compaction'" class="compact-divider turn-anchor" :data-turn-id="turn.id" role="separator">
        <span class="cd-line" aria-hidden="true" />
        <button
          v-if="turn.text"
          type="button"
          class="cd-label cd-btn"
          @click="emit('openCompaction', { turnId: turn.id })"
        >
          <span>{{ compactionDividerLabel(turn) }}</span>
          <span class="cd-view">{{ t('conversation.viewSummary') }}</span>
        </button>
        <span v-else class="cd-label">{{ compactionDividerLabel(turn) }}</span>
        <span class="cd-line" aria-hidden="true" />
      </div>

      <!-- Cron notice — a turn triggered by a scheduled reminder, rendered as
           a lightweight in-transcript notice rather than a user bubble. -->
      <CronNotice v-else-if="turn.role === 'cron'" :text="turn.text" :cron="turn.cron" :turn-id="turn.id" :created-at="turn.createdAt" />

      <!-- Assistant turn → left-aligned, no name/role label. Everything before
           the final text block folds into a TurnFold row once the turn
           settles; the final text (and any trailing blocks) stays visible. -->
      <div v-else class="a-msg turn-anchor" :data-turn-id="turn.id">
        <!-- Goal-continuation provenance: this turn was opened by goal mode,
             not the user; the line stays outside the turn fold. -->
        <div v-if="turn.goalContinuation" class="goal-prov">
          <Icon name="target" size="sm" aria-hidden="true" />
          <span>{{ t('conversation.goal.continuation') }}</span>
        </div>
        <TurnFold
          v-if="assistantFold(turn).folded.length > 0"
          :items="assistantFold(turn).folded"
          mobile
          :streaming-tail-index="streamingTailIndex(turn)"
          :live="turn.id === streamingTurnId"
          :parked="turn.id === streamingTurnId && streamingTailIndex(turn) === null"
          :seed-ms="turnActivitySeedMs(turnBlocks(turn))"
          :created-ms="isoMs(turn.createdAt)"
          :ended-ms="isoMs(turn.endedAt)"
          :duration-ms="turn.durationMs"
          @open-media="emit('openMedia', $event)"
          @open-file="emit('openFile', $event)"
          @open-agent="emit('openAgent', $event)"
        />
        <template v-for="(blk, bi) in assistantFold(turn).visible" :key="renderBlockKey(blk, bi)">
          <ThinkingBlock v-if="blk.kind === 'thinking'" :text="blk.thinking" mobile :streaming="isStreamingRenderBlock(turn, blk)" :started-at="blk.startedAt" :duration-ms="blk.durationMs" />
          <div v-else-if="blk.kind === 'text' && blk.text" class="msg"><Markdown :text="blk.text" :streaming="isStreamingRenderBlock(turn, blk)" :open-file="(target) => emit('openFile', target)" /></div>
          <ActivityRun
            v-else-if="blk.kind === 'activity-run'"
            :items="blk.items"
            mobile
            :streaming="isStreamingActivityRun(turn, blk)"
            @open-media="emit('openMedia', $event)"
            @open-file="emit('openFile', $event)"
            @open-agent="emit('openAgent', $event)"
          />
          <ToolCall v-else-if="blk.kind === 'tool'" :tool="blk.tool" mobile @open-media="emit('openMedia', $event)" @open-file="emit('openFile', $event)" @open-agent="emit('openAgent', $event)" />
          <NotificationCard v-else-if="blk.kind === 'notification'" :items="blk.items" />
        </template>
        <TurnFilesSummary
          v-if="turnFileChangesById.get(turn.id)"
          :changes="turnFileChangesById.get(turn.id)!"
          :cwd="props.cwd"
          :interactive="turnFilesInteractive"
          @open-diff="emit('openTurnDiff', $event)"
          @open-file="emit('openFile', $event)"
        />
        <div v-if="turn.id !== streamingTurnId && isAssistantRunEnd(ti) && (assistantRunFinalText(ti).trim().length > 0 || turnDurationLabel(turn))" class="a-msg-ft">
          <span v-if="turnDurationLabel(turn)" class="a-duration">{{ turnDurationLabel(turn) }}</span>
          <button
            v-if="assistantRunFinalText(ti).trim().length > 0"
            class="a-cpbtn"
            :aria-label="t('filePreview.copy')"
            @click="copyAssistantRun(ti)"
          >
            <Icon v-if="copiedTurn !== turn.id" name="copy" size="sm" />
            <Icon v-else name="check" size="sm" />
          </button>
        </div>
      </div>

      <!-- Manually stopped latest turn (Esc) — from the session's lastTurnReason. -->
      <div
        v-if="turn.role === 'assistant' && turn.id === interruptedTurnId"
        class="compact-divider"
        role="separator"
      >
        <span class="cd-line" aria-hidden="true" />
        <span class="cd-label" role="status">{{ t('conversation.turnInterrupted') }}</span>
        <span class="cd-line" aria-hidden="true" />
      </div>
    </template>

    <!-- Model-request failure (e.g. provider 429 after retry exhaustion): the
         turn died and nothing resumes it on its own — a persistent card, since
         the transient error toast alone leaves a silently dead session. -->
    <div v-if="turnFailed" class="turn-failed" role="alert">
      <span class="tf-chip" aria-hidden="true"><Icon name="alert-triangle" size="sm" /></span>
      <div class="tf-main">
        <span class="tf-title">{{ turnFailedTitle }}</span>
        <span v-if="turnError?.message" class="tf-sub" :title="turnError.message">{{ turnError.message }}</span>
        <span v-if="turnErrorMeta" class="tf-meta" :title="turnErrorMeta">{{ turnErrorMeta }}</span>
      </div>
      <Button v-if="!readOnly" variant="secondary" size="sm" @click="emit('resumeTurn')">
        {{ t('conversation.turnFailedResume') }}
      </Button>
    </div>

    <!-- Pending approvals are rendered in the bottom dock (ConversationPane),
         alongside questions, so both blocking prompts share one position. -->

    <!-- Compaction in progress — body-sized activity notice -->
    <ActivityNotice v-if="compaction" :label="t('conversation.compacting')" />

    <!-- Working placeholder — mascot + phase label while the conversation has
         an unfinished prompt (covers a page refresh mid-stream, where the
         optimistic submit flag was lost but the main turn is still in flight). -->
    <div v-if="showWorking" class="sending-placeholder">
      <WorkingIndicator :label="workingLabel" />
    </div>

    <!-- Inline queue — pending user messages shown after the running turn.
         Click to edit, × to remove, drag the grip to reorder. -->
    <div v-if="queued.length > 0" class="q-stack">
      <div class="q-head">
        <span class="q-title">
          <Icon name="mail" size="sm" />
          {{ t('composer.queueLabel') }} · <b>{{ queued.length }}</b>
        </span>
        <span class="q-hint">{{ t('composer.queueAutoDrain') }}</span>
      </div>
      <div
        v-for="(item, qi) in queued"
        :key="item.id"
        class="u-turn q-turn"
        :class="{
          'q-dragging': dragFrom === qi,
          'drop-before': dragOver?.index === qi && dragOver.position === 'before',
          'drop-after': dragOver?.index === qi && dragOver.position === 'after',
        }"
        @dragover="onQueueDragOver(qi, $event)"
        @drop="onQueueDrop(qi, $event)"
      >
        <div class="u-bub q-bub">
          <span
            class="q-grip"
            :title="t('composer.queueDragTitle')"
            draggable="true"
            @dragstart="onQueueDragStart(qi, $event)"
            @dragend="onQueueDragEnd"
          >
            <Icon name="grip" size="sm" />
          </span>
          <div class="q-clamp u-text-wrap" :class="{ 'is-clamped': isUserTextClamped(queueClampId(item)) }">
            <button
              type="button"
              class="q-body"
              :title="t('composer.editQueued')"
              :ref="(el) => registerUserTextEl(queueClampId(item), el)"
              @click="onQueueEdit(qi)"
            >
              <span v-if="item.text" class="u-text q-text">{{ item.text }}</span>
              <span v-else class="q-text q-text-placeholder">
                <Icon name="file" size="sm" />
                {{ t('composer.queuedAttachments', { n: item.attachments?.length ?? 0 }) }}
              </span>
            </button>
            <button
              v-if="clampableUserTurns.has(queueClampId(item))"
              type="button"
              class="u-text-toggle"
              :aria-expanded="!isUserTextClamped(queueClampId(item))"
              @click="toggleUserText(queueClampId(item), $event)"
            >
              <span>{{
                isUserTextClamped(queueClampId(item))
                  ? t('conversation.userMessage.expand')
                  : t('conversation.userMessage.collapse')
              }}</span>
              <Icon class="u-text-toggle-car" name="chevron-down" size="sm" aria-hidden="true" />
            </button>
          </div>
          <div v-if="hasAttachments(item)" class="q-imgs">
            <template v-for="(att, ai) in item.attachments" :key="ai">
              <span v-if="att.kind === 'file'" class="q-file">
                <Icon name="file" size="sm" />
                {{ att.name ?? att.fileId }}
              </span>
              <AuthMedia
                v-else
                :url="att.url"
                :kind="att.kind"
                :file-id="att.fileId"
                media-class="q-img"
                :controls="false"
                muted
              />
            </template>
          </div>
          <span v-if="qi === 0" class="q-tag q-tag-next">{{ t('composer.queueNext') }}</span>
          <span v-else class="q-tag q-tag-idx">#{{ qi + 1 }}</span>
          <button
            type="button"
            class="q-rm"
            :aria-label="t('composer.remove')"
            @click.stop="emit('unqueue', qi)"
          >
            <Icon name="close" size="sm" />
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Transient hint after clicking a file chip whose type can't be opened. -->
  <div v-if="unsupportedOpenName !== null" class="open-unsupported" role="status">
    {{ t('composer.attachmentOpenUnsupported', { name: unsupportedOpenName }) }}
  </div>

  <!-- Floating preview for user-bubble media thumbnails (image/video). -->
  <MediaLightbox
    v-if="mediaLightbox"
    :media="mediaLightbox"
    :origin-img="mediaLightboxImg"
    @close="
      mediaLightbox = null;
      mediaLightboxImg = null;
    "
  />
</template>

<style scoped>
.chat-empty {
  /* Fills the chat area and centers the hint vertically (parent grows via flex). */
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px 16px;
  color: var(--faint);
  text-align: center;
}
.chat-empty-text { font-size: var(--ui-font-size-sm); }

.chat-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 16px;
  color: var(--muted);
}
.chat-loading-text { font-size: var(--ui-font-size-sm); }

/* ===================== Bubble layout ===================== */
.chat {
  --chat-turn-gap: 16px;
  --chat-block-gap: 10px;
  --chat-section-gap: 18px;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 16px 14px 20px;
  flex: 1;
  min-height: 0;
  position: relative;
}
.chat .chat-empty { align-self: stretch; }

/* Bottom-center pill for the "can't open this file type" hint. */
.open-unsupported {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(90%, 480px);
  padding: 6px 12px;
  border-radius: var(--radius-md);
  border: 0.5px solid var(--color-line);
  background: var(--color-surface-raised);
  color: var(--color-text-muted);
  font-size: var(--ui-font-size-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
  z-index: var(--z-sticky);
}
.chat > .u-turn,
.chat > .a-msg,
.chat > .compact-divider,
.chat > .cron-notice,
.chat > .sending-placeholder,
.chat > :deep(.activity-notice) {
  margin-top: var(--chat-turn-gap);
}
.chat > .a-msg {
  margin-top: 10px;
}
.chat > .u-turn:first-child,
.chat > .a-msg:first-child,
.chat > .compact-divider:first-child,
.chat > .cron-notice:first-child,
.chat > .sending-placeholder:first-child,
.chat > :deep(.activity-notice:first-child) {
  margin-top: 0;
}

/* User turn — wraps the bubble + meta row so they lay out as one right-aligned group. */
.u-turn {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  align-self: flex-start;
  width: 100%;
}

/* User message → right-aligned neutral bubble (kimiwork BubbleGray:
   uniform r12, no border, no shadow — production MessageItem .user-bubble). */
.u-bub {
  align-self: flex-end;
  max-width: 78%;
  background: var(--color-user-bubble-bg);
  color: var(--color-text);
  border-radius: var(--radius-lg);
  padding: 10px 12px;
  font-size: var(--content-font-size);
  line-height: var(--leading-normal);
}
.u-meta {
  align-self: flex-end;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  max-width: 78%;
  margin-top: var(--space-2);
  margin-right: 4px;
}
.u-meta .u-edit {
  min-height: 22px;
  box-sizing: border-box;
}
/* User input is shown verbatim — preserve newlines, break long tokens. */
.u-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Overlong user text: clamp with a fade-out tail; the pill toggle expands/collapses it. */
.u-text-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
}
/* Args render outside .skill-act so one wrapper clamps both; replaces the
   card's head→args gap. */
.u-text-wrap-args {
  margin-top: var(--space-1);
}
/* Clamped: the floating toggle leaves the layout, so short-line messages need
   a floor under the bubble width or the pill overflows both sides. */
.u-text-wrap.is-clamped {
  min-width: 120px;
}
.u-text-wrap.is-clamped > .u-text,
.u-text-wrap.is-clamped > .skill-act-args,
.u-text-wrap.is-clamped > .q-body {
  max-height: calc(10 * 1lh);
  overflow: hidden;
  mask-image: linear-gradient(to bottom, black calc(100% - 5lh), transparent calc(100% - 1lh));
  -webkit-mask-image: linear-gradient(to bottom, black calc(100% - 5lh), transparent calc(100% - 1lh));
}
.u-text-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  align-self: center;
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border: none;
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-sm);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  line-height: 1;
  cursor: pointer;
  user-select: none;
  transition: box-shadow var(--duration-base) var(--ease-out);
}
.u-text-toggle:hover {
  box-shadow: var(--shadow-md);
}
.u-text-toggle:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
/* Clamped: the toggle floats over the dissolved (fully masked) tail. */
.u-text-wrap.is-clamped .u-text-toggle {
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  margin-top: 0;
}
.u-text-toggle-car {
  transition: transform var(--duration-base) var(--ease-out);
}
.u-text-toggle[aria-expanded='true'] .u-text-toggle-car {
  transform: rotate(180deg);
}

/* Undo/edit-and-resend affordance on the most recent user message. The trigger
   button sits outside the user bubble; clicking it swaps in an inline confirm
   row with Confirm/Cancel actions. */
.u-edit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 5px;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font: inherit;
  font-size: var(--text-base);
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.12s, color 0.12s, background-color 0.12s;
}
.u-edit svg {
  display: block;
  flex: none;
}
.u-edit:hover { opacity: 1; color: var(--color-accent); background: var(--hover); }
/* Armed undo hint; --undo-hint-duration matches UNDO_HINT_DURATION in
   ConversationPane. */
.u-edit-armed {
  --undo-hint-duration: 5s;
  gap: var(--space-1);
  opacity: 1;
  color: var(--color-text);
  animation: u-edit-armed-blink var(--undo-hint-duration) linear forwards;
}
.u-edit-armed:hover { color: var(--color-accent); background: var(--hover); }
.u-edit-hint {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  white-space: nowrap;
}
@keyframes u-edit-armed-blink {
  0%, 55% { opacity: 1; }
  62% { opacity: 0.45; }
  69% { opacity: 1; }
  75% { opacity: 0.4; }
  81% { opacity: 0.95; }
  86% { opacity: 0.35; }
  91% { opacity: 0.85; }
  95% { opacity: 0.3; }
  100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .u-edit-armed { animation: none; }
}
/* Copy button — icon-only, shares the undo button's muted→hover style. */
.u-copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 5px;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font: inherit;
  font-size: var(--text-base);
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.12s, color 0.12s, background-color 0.12s;
  min-height: 22px;
  box-sizing: border-box;
}
.u-copy svg { display: block; flex: none; }
.u-copy:hover { opacity: 1; color: var(--color-accent); background: var(--hover); }
/* Mobile bubble layout: right-align the undo button below the bubble. */
.u-edit-wrap { display: flex; justify-content: flex-end; }
.chat > .u-edit-wrap { margin-top: 4px; }
.chat > .u-edit-wrap + .a-msg { margin-top: 8px; }

/* Compaction divider — a full-width separator marking where the daemon
   compacted the context. Prior turns above it are untouched; clicking the
   label opens the summary in the right-side panel. */
.compact-divider {
  display: flex;
  align-items: center;
  gap: 10px;
  align-self: stretch;
  width: 100%;
  margin: var(--chat-section-gap) 0 0;
}
.chat > .compact-divider:first-child {
  margin-top: 0;
}
.cd-line {
  flex: 1;
  height: 1px;
  background: var(--line);
}
.cd-label {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 80%;
  font-size: var(--text-base);
  color: var(--muted);
  white-space: nowrap;
}
.cd-btn {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font: inherit;
  font-size: var(--text-base);
  color: var(--muted);
}
.cd-view { color: var(--color-accent); }
.cd-btn:hover .cd-view { text-decoration: underline; }

/* Failed-turn card — the persistent counterpart of the transient error toast:
   the turn died on a model-request failure and nothing resumes it by itself.
   Shell follows the notification card's danger status token pair (§04). */
.chat > .turn-failed {
  margin-top: var(--chat-turn-gap);
}
.chat > .turn-failed:first-child {
  margin-top: 0;
}
.turn-failed {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: var(--p-hairline) solid var(--color-danger-bd);
  border-radius: var(--radius-lg);
  background: var(--color-danger-soft);
  box-shadow: var(--shadow-xs);
  animation: kimi-card-in var(--duration-slow) var(--ease-out);
}
.tf-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--space-6);
  height: var(--space-6);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-xs);
  flex: none;
  color: var(--color-danger);
}
.tf-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.tf-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  line-height: var(--leading-normal);
}
.tf-sub {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tf-meta {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  line-height: var(--leading-normal);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Goal-continuation provenance line — the target glyph shared with the Goal
   tool (this turn belongs to the goal), faint 12px, flush with the stream's
   left edge. Turn-level: it never folds. */
.goal-prov {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-bottom: var(--space-1);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  user-select: none;
}

/* Assistant message → left-aligned plain column, no role label */
.a-msg {
  align-self: flex-start;
  max-width: 94%;
  width: 94%;
}
.a-msg-ft {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 8px;
  height: auto;
  margin-top: var(--chat-block-gap);
  overflow: visible;
}
.a-duration {
  display: inline-flex;
  align-items: center;
  font-size: var(--text-base);
  color: var(--muted);
  line-height: 1;
}

/* Copy button — icon-only, shares the undo button's muted→hover style so the
   message-stream action buttons (copy / undo) all read as one family. */
.a-cpbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 5px;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font: inherit;
  font-size: var(--text-base);
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.12s, color 0.12s, background-color 0.12s;
  min-height: 22px;
  box-sizing: border-box;
}
.a-cpbtn:hover {
  opacity: 1;
  color: var(--color-accent);
  background: var(--hover);
}
.a-cpbtn svg {
  display: block;
  flex: none;
}
/* Touch devices: always show the copy buttons (no hover to reveal them) and
   give the bubble-layout button a comfortable tap size. */
@media (hover: none) {
  .a-msg-ft {
    height: auto;
    margin-top: var(--chat-block-gap);
    opacity: 1;
    pointer-events: auto;
  }
  .a-cpbtn {
    font-size: var(--ui-font-size-sm);
    padding: 8px 10px;
    margin: -4px -6px;
  }
}
.a-msg .msg {
  font-size: var(--ui-font-size);
  line-height: var(--leading-prose);
  color: var(--color-text);
  font-weight: 500;
}
.a-msg .msg :deep(p) { margin: 0; }
.a-msg .msg :deep(p + p) { margin-top: 8px; }
/* ChatPane owns block spacing; child components own only their internal layout. */
.a-msg > .msg,
.a-msg > :deep(.think),
.a-msg > :deep(.tool-group),
.a-msg > :deep(.activity-run),
.a-msg > :deep(.agent-card),
.a-msg > :deep(.agent-group),
.a-msg > :deep(.tool-line),
.a-msg > :deep(.swarm-card),
.a-msg > :deep(.media-tool),
.a-msg > :deep(.ask-receipt) {
  margin-top: var(--chat-block-gap);
}
.a-msg > .msg:first-child,
.a-msg > :deep(.think:first-child),
.a-msg > :deep(.tool-group:first-child),
.a-msg > :deep(.activity-run:first-child),
.a-msg > :deep(.agent-card:first-child),
.a-msg > :deep(.agent-group:first-child),
.a-msg > :deep(.tool-line:first-child),
.a-msg > :deep(.swarm-card:first-child),
.a-msg > :deep(.media-tool:first-child),
.a-msg > :deep(.ask-receipt:first-child) {
  margin-top: 0;
}
/* The goal-continuation provenance row takes the turn's top slot: the block
   right after it keeps the same no-top-margin treatment as a first child.
   Adjacent siblings only — later blocks keep their normal gaps. */
.a-msg > .goal-prov:first-child + .msg,
.a-msg > .goal-prov:first-child + :deep(.think),
.a-msg > .goal-prov:first-child + :deep(.tool-group),
.a-msg > .goal-prov:first-child + :deep(.activity-run),
.a-msg > .goal-prov:first-child + :deep(.agent-card),
.a-msg > .goal-prov:first-child + :deep(.agent-group),
.a-msg > .goal-prov:first-child + :deep(.tool-line),
.a-msg > .goal-prov:first-child + :deep(.swarm-card),
.a-msg > .goal-prov:first-child + :deep(.media-tool),
.a-msg > .goal-prov:first-child + :deep(.ask-receipt),
.a-msg > .goal-prov:first-child + :deep(.turn-fold) {
  margin-top: 0;
}
/* Inline-code chip. Must exclude <pre> descendants: a block <code> (shiki
   output, tool-card code) is inline-level, so this chip would otherwise be
   painted once per line box — a striped band on every line. */
.a-msg :deep(:not(pre) > code) {
  font: .9em var(--font-mono);
  background: var(--color-inline-code-bg);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
  color: var(--color-accent-hover);
}

/* ===================== Wide tables (desktop) ===================== */
/* Tables stay inside the reading column by default (overflowing content
   scrolls inside the table's own wrapper); the user widens an individual
   table via the toggle injected by web-markdown's tableWide.ts, which adds
   the `md-table-wide` class. 760px corresponds to --p-content-max.
   Container-query conditions cannot reference CSS custom properties
   directly. */
@container (min-width: 760px) {
  /* markstream's content-visibility:auto implies paint containment, which can
     clip a table that breaks out of the normal Markdown width. Disable it only
     for renderers containing a manually widened table. Keep contain:layout
     intact. */
  .a-msg .msg :deep(.markstream-vue.markdown-renderer:has(.table-node-wrapper.md-table-wide)) {
    content-visibility: visible;
  }

  /* A widened table grows naturally beyond the reading column, centred within
     the conversation pane. The first-stage overflow-x:auto continues to handle
     content wider than this wrapper. */
  .a-msg .msg :deep(.table-node-wrapper.md-table-wide) {
    position: relative;
    left: 50%;
    width: max-content;
    min-width: 100%;
    max-width: min(
      var(--p-table-max),
      calc(100cqi - var(--space-5) - var(--space-5))
    ) !important;
    transform: translateX(-50%);
  }

  /* Narrow (default-width) chat tables get a tighter cell cap so simple
     tables are more likely to fit the reading column without scrolling;
     widened tables keep the full --p-table-cell-max. Scoped to the chat host
     so other Markdown consumers (file preview, narrow/mobile containers)
     keep the package default. */
  .a-msg .msg :deep(.table-node-wrapper:not(.md-table-wide)) {
    --table-cell-cap: min(var(--p-table-cell-max), 36cqi);
  }
}

/* Image/video attachments: MediaThumb rounded thumbnails above the bubble
   text — click opens the floating MediaLightbox preview. Files keep the
   AttachmentChip row. */
.u-media {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.u-media:not(:last-child) {
  margin-bottom: var(--space-2);
}

/* File attachment chips above the bubble text — the chip itself is the shared
   AttachmentChip (same as the composer's pending strip); this is only the
   row layout. */
.u-atts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

/* NOTE: Chat/bubble styles live in src/style.css (global). Scoped `.u-bub`
   rules here did NOT win the cascade, so they were moved to the global sheet. */

/* Sending placeholder */
.sending-placeholder {
  align-self: flex-start;
  padding: 10px 0;
}

/* Skill activation card (replaces raw <kimi-skill-loaded> XML) */
.skill-act {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.skill-act-head {
  font-size: var(--ui-font-size-sm);
  font-weight: 500;
  color: var(--color-accent-hover);
  display: flex;
  align-items: center;
  gap: 6px;
}
.skill-act-arrow {
  color: var(--color-accent);
  font-size: var(--text-base);
}
.skill-act-args {
  font-size: var(--text-base);
  color: var(--muted);
  padding-left: 17px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Mobile font bump (+2px) */
@media (max-width: 640px) {
  .chat {
    box-sizing: border-box;
    width: 100%;
    padding: 14px max(12px, var(--safe-right)) 18px max(12px, var(--safe-left));
  }
  .u-bub {
    max-width: min(88%, calc(100vw - 52px));
  }
  .a-msg {
    width: 100%;
    max-width: 100%;
  }
  .u-bub .u-text,
  .a-msg .msg {
    font-size: var(--ui-font-size-xl);
  }
  .a-msg :deep(.md),
  .a-msg :deep(.markdown-renderer),
  .a-msg :deep(.code-block-container),
  .a-msg :deep(.diff-wrap),
  .a-msg :deep(pre) {
    max-width: 100%;
  }
  .a-msg :deep(.code-block-container pre),
  .a-msg :deep(.diff-pre) {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .a-msg :deep(.media-tool.mob) {
    width: min(44vw, 160px);
  }
  .cd-label {
    min-width: 0;
    max-width: calc(100% - 48px);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .u-edit-confirm {
    flex-wrap: wrap;
    justify-content: flex-end;
    max-width: calc(100vw - 28px);
  }
  .ts {
    font-size: var(--ui-font-size-sm);
  }
  .chat-empty-text,
  .chat-loading-text {
    font-size: var(--ui-font-size-lg);
  }
  .cd-label,
  .cd-btn {
    font-size: var(--ui-font-size);
  }
}

/* Top sentinel for lazy-loading older messages */
.top-sentinel {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 0;
  min-height: 28px;
  /* Keep the load-older chrome out of transcript selections (Cmd/Ctrl+A). */
  user-select: none;
}
.top-sentinel-loading {
  opacity: 0.8;
}
.top-sentinel-btn {
  appearance: none;
  border: 0.5px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: var(--ui-font-size-sm);
  padding: 4px 12px;
  border-radius: 999px;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.top-sentinel-btn:hover {
  color: var(--fg);
  border-color: var(--fg);
}
.top-sentinel-text {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: var(--ui-font-size-sm);
}

.chat { background: transparent; }
.chat {
  gap: 0;
  padding: 22px 20px 26px;
}
.u-bub {
  background: var(--color-user-bubble-bg);
  border-radius: var(--radius-lg);
  padding: 10px 12px;
}
.a-msg {
  max-width: 100%;
  width: 100%;
}

/* ---- Inline queue: pending user messages at the tail of the transcript ----
   Reuses .u-turn / .u-bub so the pending bubbles sit in the same right-aligned
   column as real user turns; the .q-bub modifier swaps in a lower-emphasis
   "not yet sent" treatment (surface fill + dashed border). */
.chat > .q-stack {
  margin-top: var(--chat-turn-gap);
}
.chat > .q-stack:first-child {
  margin-top: 0;
}
.q-stack {
  align-self: flex-end;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.q-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 6px;
  color: var(--color-text-faint);
  font-size: var(--ui-font-size-xs);
}
.q-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.q-title b {
  color: var(--color-accent-hover);
  font-weight: var(--weight-medium);
}
.q-hint {
  color: var(--color-text-faint);
}
.q-turn {
  position: relative;
}
.q-bub {
  display: flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  background: var(--color-surface-raised);
  border: 0.5px dashed var(--color-accent-bd);
  padding: 8px 8px 8px 6px;
  transition: border-color 0.12s ease, background 0.12s ease;
}
.q-bub:hover {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}
.q-grip {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 2px;
  color: var(--color-text-faint);
  cursor: grab;
  opacity: 0.7;
}
.q-grip:hover {
  opacity: 1;
}
.q-grip:active {
  cursor: grabbing;
}
/* The clamp wrapper takes .q-body's place as the flex:1 item in the queue row. */
.q-clamp {
  flex: 1;
  min-width: 0;
}
.q-body {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
  opacity: 0.82;
}
.q-bub:hover .q-body {
  opacity: 1;
}
.q-body:disabled {
  cursor: default;
}
.q-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.q-text-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-text-muted);
}
.q-imgs {
  display: flex;
  gap: 4px;
  flex: none;
}
.q-img {
  width: 28px;
  height: 28px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 0.5px solid var(--color-line);
}
.q-file {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  border: 0.5px solid var(--color-line);
  color: var(--color-text-muted);
  font-size: calc(var(--ui-font-size) - 3px);
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.q-tag {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  font-size: var(--ui-font-size-xs);
  font-weight: var(--weight-medium);
  line-height: 1.4;
  white-space: nowrap;
}
.q-tag-next {
  color: var(--color-accent-hover);
  background: var(--color-accent-soft);
  border: 0.5px solid var(--color-accent-bd);
}
.q-tag-idx {
  color: var(--color-text-faint);
  background: var(--color-surface-sunken);
  border: 0.5px solid var(--color-line);
}
.q-rm {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--color-text-faint);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
}
.q-bub:hover .q-rm,
.q-bub:focus-within .q-rm,
.q-rm:focus-visible {
  opacity: 1;
}
.q-rm:hover {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
/* Drag reorder: dim the row being dragged, show an insertion line on the target. */
.q-turn.q-dragging .q-bub {
  opacity: 0.45;
}
.q-turn.drop-before::before,
.q-turn.drop-after::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--color-accent);
  border-radius: var(--radius-full);
  z-index: 1;
}
.q-turn.drop-before::before {
  top: -5px;
}
.q-turn.drop-after::after {
  bottom: -5px;
}

</style>
