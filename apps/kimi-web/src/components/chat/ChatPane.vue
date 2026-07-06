<!-- apps/kimi-web/src/components/chat/ChatPane.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatTurn, ApprovalBlock, FilePreviewRequest, ToolMedia, QueuedPromptView } from '../../types';
import ToolCall from './ToolCall.vue';
import ToolGroup from './ToolGroup.vue';
import Markdown from './Markdown.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import ActivityNotice from './ActivityNotice.vue';
import AuthMedia from './AuthMedia.vue';
import MoonSpinner from '../ui/MoonSpinner.vue';
import Spinner from '../ui/Spinner.vue';
import Icon from '../ui/Icon.vue';
import Tooltip from '../ui/Tooltip.vue';
import { useConfirmDialog } from '../../composables/useConfirmDialog';
import { formatMessageTime } from '../../lib/formatMessageTime';
import { copyTextToClipboard } from '../../lib/clipboard';
import {
  assistantRenderBlocks,
  formatDuration,
  formatTokens,
  renderBlockKey,
  turnBlocks,
  turnFinalText,
  turnToMarkdown,
} from '../chatTurnRendering';

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
});

const props = withDefaults(
  defineProps<{
    turns: ChatTurn[];
    approvals?: { approvalId: string; block: ApprovalBlock; agentName?: string }[];
    /**
     * True while the active session is busy (activity !== idle). Used to mark the
     * last assistant turn as actively streaming so its Markdown animates the
     * smooth typewriter/fade reveal; all other turns render statically.
     */
    running?: boolean;
    /**
     * True immediately after the user hits send and before the assistant reply
     * starts streaming. Renders a moon-spinner placeholder at the end of the
     * transcript so the user knows the request is in flight.
     */
    sending?: boolean;
    /** Switches the CSS-only working moon to the faster visual cadence. */
    fastMoon?: boolean;
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
    /**
     * When true, clicking an Edit/Write tool card opens the right-side diff
     * panel. Off in contexts that don't wire the panel (e.g. the side chat), so
     * cards there expand inline instead.
     */
    toolDiffPanel?: boolean;
    /**
     * Pending user messages queued while the session is busy. Rendered inline
     * at the tail of the transcript (after the running turn) — click to edit,
     * × to remove, drag the grip to reorder.
     */
    queued?: QueuedPromptView[];
    /**
     * @deprecated No longer used — Composer is rendered by ConversationPane.
     */
  }>(),
  {
    approvals: () => [],
    running: false,
    sending: false,
    fastMoon: false,
    compaction: null,
    hasMoreMessages: false,
    loadingMore: false,
    loadingMoreError: false,
    isFollowing: false,
    toolDiffPanel: false,
    queued: () => [],
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
// the session is running. Its Markdown renders with `streaming` (final=false);
// every other turn renders statically.
const streamingTurnId = computed<string | null>(() => {
  if (!props.running || props.turns.length === 0) return null;
  const last = props.turns.at(-1)!;
  return last.role === 'assistant' ? last.id : null;
});

// Trailing "working" moon. `sending` is an optimistic flag set on submit and
// kept until the session goes idle, so during a normal turn the moon shows the
// whole time. After a page refresh that in-memory flag is gone, so fall back to
// `running` (restored from the session's live status) — otherwise a refresh mid
// stream froze the transcript with no "still working" indicator. Either flag
// shows the same moon footer.
const showWorking = computed(() => props.sending || props.running);

const emit = defineEmits<{
  openFile: [target: FilePreviewRequest];
  openMedia: [media: ToolMedia];
  copyConversationCopied: [];
  /** Show a thinking block's full text in the right-side panel. */
  openThinking: [target: { turnId: string; blockIndex: number }];
  /** Show a compaction divider's summary text in the right-side panel. */
  openCompaction: [target: { turnId: string }];
  /** Show a subagent's live detail in the right-side panel (keyed by the
   *  spawning `Agent` tool-call id). */
  openAgent: [toolCallId: string];
  /** Show an Edit/Write tool call's diff in the right-side panel. */
  openToolDiff: [id: string];
  /** Edit + resend the last user message (parent undoes, then refills composer). */
  editMessage: [payload: { text: string; images?: { url: string; alt?: string; kind: 'image' | 'video'; fileId?: string }[] }];
  /** Fetch the next older page of messages (triggered by top sentinel visibility or click). */
  loadOlderMessages: [];
  /** Remove a queued message by index. */
  unqueue: [index: number];
  /** Load a queued message back into the composer for editing (and dequeue it). */
  editQueued: [index: number];
  /** Drag-to-reorder a queued message within the active session's queue. */
  reorderQueue: [payload: { from: number; to: number }];
}>();

// ---- Inline queue (pending messages while running) ------------------------
// Edit/remove are one-click; reorder is HTML5 drag-and-drop initiated from the
// grip handle (the body stays a click-to-edit button).
const dragFrom = ref<number | null>(null);
const dragOver = ref<{ index: number; position: 'before' | 'after' } | null>(null);

function hasImages(item: QueuedPromptView): boolean {
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
// affordance (undo only rewinds the latest exchange).
const lastUserTurnId = computed<string | null>(() => {
  for (let i = props.turns.length - 1; i >= 0; i--) {
    if (props.turns[i]!.role === 'user') return props.turns[i]!.id;
  }
  return null;
});

/** Whether to offer "edit & resend" on this turn: the latest user message, only
    while the session is idle (not mid-reply) and it isn't a slash activation. */
function canEditTurn(turn: ChatTurn): boolean {
  return (
    turn.role === 'user' &&
    turn.id === lastUserTurnId.value &&
    !props.running &&
    !props.sending &&
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

// Undo in-flight guard (keyed by turn id) — set while the server rewinds the
// turn so a second undo can't fire until the first one settles.
const undoingTurnId = ref<string | null>(null);
// Fallback that releases the undoing state if the server rewind never removes
// the turn (e.g. the undo failed). Without it the guard in confirmEditMessage
// would block any further undo.
let undoFallbackTimer: ReturnType<typeof setTimeout> | null = null;
const UNDO_FALLBACK_MS = 2500;

// Expanded timestamp state (keyed by turn id)
const expandedTimeTurnIds = ref<Set<string>>(new Set());
function isTimeExpanded(turnId: string): boolean {
  return expandedTimeTurnIds.value.has(turnId);
}
function toggleTime(turnId: string): void {
  const next = new Set(expandedTimeTurnIds.value);
  if (next.has(turnId)) next.delete(turnId);
  else next.add(turnId);
  expandedTimeTurnIds.value = next;
}
function displayMessageTime(iso: string, turnId: string): string {
  if (isTimeExpanded(turnId)) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad2 = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return formatMessageTime(iso, t('conversation.yesterday'));
}

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
  emit('editMessage', { text: turn.text, images: turn.images });
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
    if (turn.role === 'compaction') continue; // dividers don't copy
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

function assistantRunFinalText(index: number): string {
  return assistantRunEndingAt(index)
    .map((t) => turnFinalText(t))
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

function userImageMedia(img: { url: string; alt?: string; fileId?: string }): ToolMedia {
  // User-uploaded images carry no path/mime metadata; the preview panel falls
  // back to a generic label and sniffs the mime from the URL when needed. When
  // a fileId is present the preview fetches the bytes with auth (a bare
  // getFileUrl src 401s under daemon auth).
  return { kind: 'image', url: img.url, path: img.alt, fileId: img.fileId };
}

function isStreamingRenderBlock(turn: ChatTurn, block: { sourceIndex: number }): boolean {
  if (turn.id !== streamingTurnId.value) return false;
  return block.sourceIndex === turnBlocks(turn).length - 1;
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
            <!-- Image / video attachments -->
            <div v-if="turn.images && turn.images.length > 0" class="u-imgs">
              <template v-for="(img, ii) in turn.images" :key="ii">
                <AuthMedia
                  v-if="img.kind === 'video'"
                  :url="img.url"
                  kind="video"
                  :file-id="img.fileId"
                  media-class="u-img"
                />
                <button
                  v-else
                  type="button"
                  class="u-img-btn"
                  :aria-label="t('filePreview.enlargeImage')"
                  @click="emit('openMedia', userImageMedia(img))"
                >
                  <AuthMedia
                    :url="img.url"
                    kind="image"
                    :alt="img.alt"
                    :file-id="img.fileId"
                    media-class="u-img"
                  />
                </button>
              </template>
            </div>
            <!-- Skill activation card (replaces raw XML) -->
            <div v-if="turn.skillActivation" class="skill-act">
              <div class="skill-act-head">
                <span class="skill-act-arrow">▶</span>
                <span>{{ t('conversation.activatedSkill', { name: turn.skillActivation.name }) }}</span>
              </div>
              <div v-if="turn.skillActivation.args" class="skill-act-args">{{ turn.skillActivation.args }}</div>
            </div>
            <!-- Plugin command card (replaces expanded body) -->
            <div v-else-if="turn.pluginCommand" class="skill-act">
              <div class="skill-act-head">
                <span class="skill-act-arrow">▶</span>
                <span>/{{ turn.pluginCommand.pluginId }}:{{ turn.pluginCommand.commandName }}</span>
              </div>
              <div v-if="turn.pluginCommand.args" class="skill-act-args">{{ turn.pluginCommand.args }}</div>
            </div>
            <!-- User input renders verbatim (pre-wrap), never through Markdown -->
            <div v-else class="u-text">{{ turn.text }}</div>
          </div>
          <div v-if="turn.createdAt || canEditTurn(turn)" class="u-meta">
            <div v-if="canEditTurn(turn)" class="u-edit-wrap" :class="{ undoing: undoingTurnId === turn.id }">
              <button
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
            <button
              v-if="turn.createdAt"
              type="button"
              class="u-time"
              @click.stop="toggleTime(turn.id)"
            >
              {{ displayMessageTime(turn.createdAt, turn.id) }}
            </button>
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

      <!-- Assistant turn → left-aligned, no name/role label. -->
      <div v-else class="a-msg turn-anchor" :data-turn-id="turn.id">
        <template v-for="(blk, bi) in assistantRenderBlocks(turn)" :key="renderBlockKey(blk, bi)">
          <ThinkingBlock v-if="blk.kind === 'thinking'" :text="blk.thinking" mobile :streaming="isStreamingRenderBlock(turn, blk)" @open="emit('openThinking', { turnId: turn.id, blockIndex: blk.sourceIndex })" />
          <div v-else-if="blk.kind === 'text' && blk.text" class="msg"><Markdown :text="blk.text" :streaming="isStreamingRenderBlock(turn, blk)" :open-file="(target) => emit('openFile', target)" /></div>
          <ToolGroup
            v-else-if="blk.kind === 'tool-stack'"
            :tools="blk.tools"
            mobile
            :tool-diff-panel="toolDiffPanel"
            @open-media="emit('openMedia', $event)"
            @open-file="emit('openFile', $event)"
            @open-tool-diff="emit('openToolDiff', $event)"
            @open-agent="emit('openAgent', $event)"
          />
          <ToolCall v-else-if="blk.kind === 'tool'" :tool="blk.tool" mobile :tool-diff-panel="toolDiffPanel" @open-media="emit('openMedia', $event)" @open-file="emit('openFile', $event)" @open-tool-diff="emit('openToolDiff', $event)" @open-agent="emit('openAgent', $event)" />
        </template>
        <div v-if="turn.id !== streamingTurnId && isAssistantRunEnd(ti) && (assistantRunFinalText(ti).trim().length > 0 || turn.durationMs !== undefined)" class="a-msg-ft">
          <Tooltip :text="`${turn.durationMs} ms`">
            <span v-if="turn.durationMs !== undefined" class="a-duration">{{ formatDuration(turn.durationMs) }}</span>
          </Tooltip>
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
    </template>

    <!-- Pending approvals are rendered in the bottom dock (ConversationPane),
         alongside questions, so both blocking prompts share one position. -->

    <!-- Compaction in progress — body-sized moon activity notice -->
    <ActivityNotice v-if="compaction" :label="t('conversation.compacting')" />

    <!-- Working placeholder — moon spinner while the turn is in flight (covers
         a page refresh mid-stream, where `sending` was lost but the session is
         still running). -->
    <div v-if="showWorking" class="sending-placeholder">
      <MoonSpinner :fast="fastMoon" />
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
        :key="qi"
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
          <button
            type="button"
            class="q-body"
            :title="t('composer.editQueued')"
            @click="onQueueEdit(qi)"
          >
            <span v-if="item.text" class="u-text q-text">{{ item.text }}</span>
            <span v-else class="q-text q-text-placeholder">
              <Icon name="image" size="sm" />
              {{ t('composer.queuedImageOnly', { n: item.attachments?.length ?? 0 }) }}
            </span>
          </button>
          <div v-if="hasImages(item)" class="q-imgs">
            <AuthMedia
              v-for="(att, ai) in item.attachments"
              :key="ai"
              :url="att.url"
              :kind="att.kind"
              :file-id="att.fileId"
              media-class="q-img"
              :controls="false"
              muted
            />
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
}
.chat .chat-empty { align-self: stretch; }
.chat > .u-turn,
.chat > .a-msg,
.chat > .compact-divider,
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

/* User message → right-aligned soft-blue bubble (redesign .p-bubble-user). */
.u-bub {
  align-self: flex-end;
  max-width: 78%;
  background: var(--color-accent-soft);
  border: 1px solid var(--color-accent-bd);
  color: var(--color-text);
  border-radius: var(--radius-xl) var(--radius-xl) var(--radius-sm) var(--radius-xl);
  padding: 11px 15px;
  font-size: var(--content-font-size);
  line-height: var(--leading-normal);
  box-shadow: var(--shadow-xs);
}
.u-meta {
  align-self: flex-end;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  max-width: 78%;
  margin-top: 2px;
  margin-right: 4px;
}
.u-meta .u-time {
  display: inline-flex;
  align-items: center;
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
  white-space: nowrap;
}
.u-meta .u-time:hover {
  opacity: 1;
  color: var(--color-accent);
  background: var(--hover);
}
.u-meta .u-edit,
.u-meta .u-time {
  min-height: 22px;
  box-sizing: border-box;
}
/* User input is shown verbatim — preserve newlines, break long tokens. */
.u-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
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
  line-height: 1.6;
  color: var(--color-text);
  font-weight: 500;
}
.a-msg .msg :deep(p) { margin: 0; }
.a-msg .msg :deep(p + p) { margin-top: 8px; }
/* ChatPane owns block spacing; child components own only their internal layout. */
.a-msg > .msg,
.a-msg > :deep(.think),
.a-msg > :deep(.tool-group),
.a-msg > :deep(.agent-card),
.a-msg > :deep(.agent-group),
.a-msg > :deep(.box),
.a-msg > :deep(.swarm-card),
.a-msg > :deep(.media-tool) {
  margin-top: var(--chat-block-gap);
}
.a-msg > .msg:first-child,
.a-msg > :deep(.think:first-child),
.a-msg > :deep(.tool-group:first-child),
.a-msg > :deep(.agent-card:first-child),
.a-msg > :deep(.agent-group:first-child),
.a-msg > :deep(.box:first-child),
.a-msg > :deep(.swarm-card:first-child),
.a-msg > :deep(.media-tool:first-child) {
  margin-top: 0;
}
.a-msg :deep(code) {
  font: .9em var(--font-mono);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
  color: var(--color-accent-hover);
}

.u-imgs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.u-img {
  max-width: 100%;
  max-height: 200px;
  border-radius: 8px;
  object-fit: cover;
}
/* Clickable image thumbnail — reset button chrome so it looks like the plain
   image it replaced, while still opening the preview on click. */
.u-img-btn {
  display: block;
  flex: none;
  align-self: flex-start;
  max-width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 8px;
  overflow: hidden;
}
.u-img-btn .u-img {
  display: block;
}
.u-img-btn:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
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
    padding: 14px max(12px, env(safe-area-inset-right)) 18px max(12px, env(safe-area-inset-left));
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
}
.top-sentinel-loading {
  opacity: 0.8;
}
.top-sentinel-btn {
  appearance: none;
  border: 1px solid var(--border);
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
  background: var(--color-accent-soft);
  border-color: var(--color-accent-bd);
  border-radius: var(--radius-xl) var(--radius-xl) var(--radius-sm) var(--radius-xl);
  padding: 11px 15px;
  box-shadow: var(--shc);
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
  border: 1px dashed var(--color-accent-bd);
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
  border: 1px solid var(--color-line);
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
  border: 1px solid var(--color-accent-bd);
}
.q-tag-idx {
  color: var(--color-text-faint);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
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
