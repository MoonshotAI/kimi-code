<!-- apps/kimi-web/src/components/ChatPane.vue -->
<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatTurn, ApprovalBlock, FilePreviewRequest, ToolMedia, TurnBlock } from '../types';
import ToolCall from './ToolCall.vue';
import Markdown from './Markdown.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import ActivityNotice from './ActivityNotice.vue';
import AgentCard from './AgentCard.vue';
import AgentGroup from './AgentGroup.vue';
import MoonSpinner from './MoonSpinner.vue';
import { formatMessageTime } from '../lib/formatMessageTime';

const { t } = useI18n();

onUnmounted(() => {
  if (copiedTimer !== null) {
    clearTimeout(copiedTimer);
    copiedTimer = null;
  }
  if (copiedConversationTimer !== null) {
    clearTimeout(copiedConversationTimer);
    copiedConversationTimer = null;
  }
  if (undoTimer !== null) {
    clearTimeout(undoTimer);
    undoTimer = null;
  }
});

const props = withDefaults(
  defineProps<{
    turns: ChatTurn[];
    approvals?: { approvalId: string; block: ApprovalBlock; agentName?: string }[];
    /**
     * Bubble chat layout: render each turn as a chat bubble (user = right-aligned
     * soft-blue bubble, assistant = left-aligned plain text with no role label)
     * instead of the desktop `user@kimi $` / `kimi >` line-turns. Driven by the
     * Modern desktop theme OR a narrow (phone) viewport.
     */
    bubble?: boolean;
    /**
     * Backwards-compatible alias for `bubble` (the phone shell still passes
     * `mobile`). Either prop enables the bubble layout.
     */
    mobile?: boolean;
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
     * @deprecated No longer used — Composer is rendered by ConversationPane.
     */
  }>(),
  { approvals: () => [], bubble: false, mobile: false, running: false, sending: false, fastMoon: false, compaction: null },
);

// Bubble layout is active on phones AND on the Modern desktop theme. ThinkingBlock
// / ToolCall use their soft "bubble" rendering in the same condition.
const childBubble = computed(() => props.bubble || props.mobile);

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
  /** Show a subagent's full detail in the right-side panel. */
  openAgent: [target: { turnId: string; blockIndex: number; memberId: string }];
  /** Edit + resend the last user message (parent undoes, then refills composer). */
  editMessage: [text: string];
}>();

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
    !turn.skillActivation
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(1);
  return `${m}m${s}s`;
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

// Undo/edit-and-resend confirmation state (keyed by turn id)
const confirmingEditTurnId = ref<string | null>(null);
const undoingTurnId = ref<string | null>(null);
let undoTimer: ReturnType<typeof setTimeout> | null = null;

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

function confirmEditMessage(turn: ChatTurn): void {
  if (undoingTurnId.value !== null) return;
  confirmingEditTurnId.value = null;
  undoingTurnId.value = turn.id;
  undoTimer = setTimeout(() => {
    undoTimer = null;
    emit('editMessage', turn.text);
    undoingTurnId.value = null;
  }, 240);
}

// Copy-whole-conversation state
const copiedConversation = ref(false);
let copiedConversationTimer: ReturnType<typeof setTimeout> | null = null;

function turnFinalText(turn: ChatTurn): string {
  return turnBlocks(turn)
    .flatMap((blk) => (blk.kind === 'text' && blk.text ? [blk.text] : []))
    .join('\n\n');
}

/** Convert a single turn to Markdown. */
function turnToMarkdown(turn: ChatTurn): string {
  const parts: string[] = [];
  for (const blk of turnBlocks(turn)) {
    if (blk.kind === 'thinking' && blk.thinking) {
      parts.push(`> **Thinking**\n> ${blk.thinking.split('\n').join('\n> ')}`);
    } else if (blk.kind === 'text' && blk.text) {
      parts.push(blk.text);
    } else if (blk.kind === 'tool' && blk.tool.output && blk.tool.output.length > 0) {
      const output = blk.tool.output.join('\n');
      parts.push(`\`\`\`\n[${blk.tool.name}]\n${output}\n\`\`\``);
    } else if (blk.kind === 'agent') {
      parts.push(`**Agent** ${blk.member.name} (${blk.member.phase})`);
    } else if (blk.kind === 'agentGroup') {
      parts.push(`**Agents**\n\n${blk.members.map((member) => `- ${member.name}: ${member.phase}`).join('\n')}`);
    }
  }
  return parts.join('\n\n');
}

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
  navigator.clipboard.writeText(markdown).then(() => {
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
  navigator.clipboard.writeText(text).then(() => {
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
  navigator.clipboard.writeText(text).then(() => {
    copiedTurn.value = turn.id;
    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedTimer = null;
      copiedTurn.value = null;
    }, 1400);
  }).catch(() => {/* ignore */});
}

// Ordered render blocks for an assistant turn. messagesToTurns supplies `blocks`
// (thinking + text + tool cards in call order); fall back to deriving them from
// the aggregate fields for any turn built without blocks (e.g. unit tests).
function turnBlocks(turn: ChatTurn): TurnBlock[] {
  if (turn.blocks) return turn.blocks;
  const blocks: TurnBlock[] = [];
  if (turn.thinking) blocks.push({ kind: 'thinking', thinking: turn.thinking });
  if (turn.text) blocks.push({ kind: 'text', text: turn.text });
  for (const tool of turn.tools ?? []) blocks.push({ kind: 'tool', tool });
  return blocks;
}

type ToolStackPosition = 'single' | 'first' | 'middle' | 'last';

type ToolStackItem = {
  tool: Extract<TurnBlock, { kind: 'tool' }>['tool'];
  sourceIndex: number;
};

type AssistantRenderBlock =
  | { kind: 'thinking'; thinking: string; sourceIndex: number }
  | { kind: 'text'; text: string; sourceIndex: number }
  | { kind: 'tool'; tool: ToolStackItem['tool']; sourceIndex: number }
  | { kind: 'tool-stack'; tools: ToolStackItem[] }
  | { kind: 'agent'; member: Extract<TurnBlock, { kind: 'agent' }>['member']; sourceIndex: number }
  | { kind: 'agentGroup'; members: Extract<TurnBlock, { kind: 'agentGroup' }>['members']; sourceIndex: number };

function rendersToolCard(block: Extract<TurnBlock, { kind: 'tool' }>): boolean {
  return !(block.tool.status === 'ok' && block.tool.media);
}

function toolStackPosition(index: number, count: number): ToolStackPosition {
  if (count <= 1) return 'single';
  if (index === 0) return 'first';
  if (index === count - 1) return 'last';
  return 'middle';
}

function assistantRenderBlocks(turn: ChatTurn): AssistantRenderBlock[] {
  const blocks = turnBlocks(turn);
  const rendered: AssistantRenderBlock[] = [];
  let toolRun: ToolStackItem[] = [];

  const flushToolRun = () => {
    if (toolRun.length === 1) {
      const [item] = toolRun;
      if (item) rendered.push({ kind: 'tool', tool: item.tool, sourceIndex: item.sourceIndex });
    } else if (toolRun.length > 1) {
      rendered.push({ kind: 'tool-stack', tools: toolRun });
    }
    toolRun = [];
  };

  blocks.forEach((block, sourceIndex) => {
    if (block.kind === 'tool') {
      if (rendersToolCard(block)) {
        toolRun.push({ tool: block.tool, sourceIndex });
        return;
      }
      flushToolRun();
      rendered.push({ kind: 'tool', tool: block.tool, sourceIndex });
      return;
    }

    flushToolRun();
    if (block.kind === 'thinking') {
      rendered.push({ kind: 'thinking', thinking: block.thinking, sourceIndex });
    } else if (block.kind === 'text') {
      rendered.push({ kind: 'text', text: block.text, sourceIndex });
    } else if (block.kind === 'agent') {
      rendered.push({ kind: 'agent', member: block.member, sourceIndex });
    } else {
      rendered.push({ kind: 'agentGroup', members: block.members, sourceIndex });
    }
  });

  flushToolRun();
  return rendered;
}

function isStreamingRenderBlock(turn: ChatTurn, block: { sourceIndex: number }): boolean {
  if (turn.id !== streamingTurnId.value) return false;
  return block.sourceIndex === turnBlocks(turn).length - 1;
}

function toolStackKey(item: ToolStackItem): string {
  return item.tool.id || `tool-${item.sourceIndex}`;
}

function renderBlockKey(block: AssistantRenderBlock, index: number): string {
  if (block.kind === 'tool-stack') {
    return `tool-stack-${block.tools[0]?.sourceIndex ?? index}`;
  }
  if (block.kind === 'tool') return toolStackKey({ tool: block.tool, sourceIndex: block.sourceIndex });
  if (block.kind === 'agent') return `agent-${block.member.id}-${block.sourceIndex}`;
  if (block.kind === 'agentGroup') return `agent-group-${block.members[0]?.id ?? block.sourceIndex}`;
  return `${block.kind}-${block.sourceIndex}`;
}

// NOTE: the turn-summary line ("已调用 N 个工具…") was removed in f9417af. If it
// comes back, rebuild it from turnBlocks() with i18n strings — the old
// implementation lives in git history at f9417af^.
</script>

<template>
  <!-- ===================== MOBILE: chat bubbles ===================== -->
  <!-- Same ChatTurn data as desktop, rendered as bubbles. User turns are
       right-aligned soft-blue bubbles (no `user@kimi $` prefix, no line number);
       assistant turns are left-aligned plain text with NO role/name label,
       showing in order: thinking → message text → tool cards. -->
  <div v-if="childBubble" class="chat">
    <div v-if="sessionLoading" class="chat-loading">
      <span class="dot-pulse" aria-hidden="true" />
      <span class="chat-loading-text">{{ t('conversation.loading') }}</span>
    </div>
    <div v-else-if="turns.length === 0 && (!approvals || approvals.length === 0)" class="chat-empty" />

    <template v-for="(turn, ti) in turns" :key="turn.id">
      <!-- User turn → right-aligned soft-blue bubble (undo affordance lives
           outside the bubble with an inline confirm step). -->
      <template v-if="turn.role === 'user'">
        <div class="u-bub turn-anchor" :class="{ undoing: undoingTurnId === turn.id }" :data-turn-id="turn.id">
          <!-- Image / video attachments -->
          <div v-if="turn.images && turn.images.length > 0" class="u-imgs">
            <template v-for="(img, ii) in turn.images" :key="ii">
              <video
                v-if="img.kind === 'video'"
                class="u-img"
                :src="img.url"
                controls
                playsinline
                preload="metadata"
              />
              <img
                v-else
                class="u-img"
                :src="img.url"
                :alt="img.alt || ''"
                loading="lazy"
              />
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
          <!-- User input renders verbatim (pre-wrap), never through Markdown -->
          <div v-else class="u-text">{{ turn.text }}</div>
        </div>
        <div v-if="turn.createdAt || canEditTurn(turn)" class="u-meta">
          <div v-if="canEditTurn(turn)" class="u-edit-wrap" :class="{ undoing: undoingTurnId === turn.id }">
            <button
              v-if="confirmingEditTurnId !== turn.id"
              type="button"
              class="u-edit"
              :data-tooltip="t('conversation.undoTooltip')"
              @click="confirmingEditTurnId = turn.id"
            >
              <span class="u-edit-text">{{ t('conversation.undo') }}</span>
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M6.5 2.5 3 6l3.5 3.5"/>
                <path d="M3 6h6.5a3.8 3.8 0 1 1 0 7.6H7.5"/>
              </svg>
            </button>
            <div v-else class="u-edit-confirm" @click.stop>
              <span>{{ t('conversation.undoConfirm') }}</span>
              <button
                type="button"
                class="u-edit-confirm-btn confirm"
                @click.stop="confirmEditMessage(turn)"
              >
                {{ t('conversation.confirm') }}
              </button>
              <button
                type="button"
                class="u-edit-confirm-btn"
                @click.stop="confirmingEditTurnId = null"
              >
                {{ t('conversation.cancel') }}
              </button>
            </div>
          </div>
          <button
            v-if="turn.createdAt"
            type="button"
            class="u-time"
            @click.stop="toggleTime(turn.id)"
          >
            {{ displayMessageTime(turn.createdAt, turn.id) }}
          </button>
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
          <ThinkingBlock v-if="blk.kind === 'thinking'" :text="blk.thinking" :mobile="childBubble" :streaming="isStreamingRenderBlock(turn, blk)" @open="emit('openThinking', { turnId: turn.id, blockIndex: blk.sourceIndex })" />
          <div v-else-if="blk.kind === 'text' && blk.text" class="msg"><Markdown :text="blk.text" :streaming="isStreamingRenderBlock(turn, blk)" :open-file="(target) => emit('openFile', target)" /></div>
          <div v-else-if="blk.kind === 'tool-stack'" class="tool-stack">
            <ToolCall v-for="(item, si) in blk.tools" :key="toolStackKey(item)" :tool="item.tool" :mobile="childBubble" :stack-position="toolStackPosition(si, blk.tools.length)" @open-media="emit('openMedia', $event)" />
          </div>
          <AgentCard v-else-if="blk.kind === 'agent'" :member="blk.member" @open="emit('openAgent', { turnId: turn.id, blockIndex: blk.sourceIndex, memberId: $event })" />
          <AgentGroup v-else-if="blk.kind === 'agentGroup'" :members="blk.members" @open="emit('openAgent', { turnId: turn.id, blockIndex: blk.sourceIndex, memberId: $event })" />
          <ToolCall v-else-if="blk.kind === 'tool'" :tool="blk.tool" :mobile="childBubble" @open-media="emit('openMedia', $event)" />
        </template>
        <div v-if="turn.id !== streamingTurnId && isAssistantRunEnd(ti) && (assistantRunFinalText(ti).trim().length > 0 || turn.durationMs !== undefined)" class="a-msg-ft">
          <span v-if="turn.durationMs !== undefined" class="a-duration" :title="`${turn.durationMs} ms`">{{ formatDuration(turn.durationMs) }}</span>
          <button
            v-if="assistantRunFinalText(ti).trim().length > 0"
            class="a-cpbtn"
            tabindex="-1"
            @click="copyAssistantRun(ti)"
          >
            <svg v-if="copiedTurn !== turn.id" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="9" height="9" rx="1.5"/>
              <path d="M6 1h7a1 1 0 0 1 1 1v7"/>
            </svg>
            <svg v-else viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="3,8 6.5,11.5 13,5"/>
            </svg>
            <span class="a-cpbtn-text">{{ t('filePreview.copy') }}</span>
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
  </div>

  <!-- ===================== DESKTOP: line-turns ===================== -->
  <div v-else class="term">
    <!-- Loading state: shown while fetching a historical session's turns -->
    <div v-if="sessionLoading" class="chat-loading">
      <span class="dot-pulse" aria-hidden="true" />
      <span class="chat-loading-text">{{ t('conversation.loading') }}</span>
    </div>
    <!-- Empty state: a fresh/empty session shows a blank pane (Composer lives in
         the dock, moved here by ConversationPane when workspaceEmpty). -->
    <div v-else-if="turns.length === 0 && (!approvals || approvals.length === 0)" class="chat-empty" />

    <template v-for="(turn, ti) in turns" :key="turn.id">
      <!-- Compaction divider — full-width separator, no gutter number. -->
      <div v-if="turn.role === 'compaction'" class="compact-divider turn-anchor" :data-turn-id="turn.id" role="separator">
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

      <div
        v-else
        class="ln turn-anchor"
        :data-turn-id="turn.id"
        :class="[turn.role === 'user' ? 'userline' : 'ai', { undoing: undoingTurnId === turn.id }]"
      >
        <!-- Line-number gutter -->
        <span class="no">{{ turn.no }}</span>

        <div class="tx">
          <!-- Role prefix -->
          <div class="role-row">
            <template v-if="turn.role === 'user'">
              <span class="pr">user@kimi</span>
              <span class="who"> $ </span>
            </template>
            <template v-else>
              <span class="pr">kimi</span>
              <span class="who"> &gt; </span>
            </template>

            <!-- Per-message copy button (always visible, only when turn is complete) -->
            <button v-if="turn.id !== streamingTurnId && isAssistantRunEnd(ti) && assistantRunFinalText(ti).trim().length > 0" class="cpbtn" @click="copyAssistantRun(ti)" tabindex="-1">
              <svg v-if="copiedTurn !== turn.id" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="9" height="9" rx="1.5"/>
                <path d="M6 1h7a1 1 0 0 1 1 1v7"/>
              </svg>
              <svg v-else viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="3,8 6.5,11.5 13,5"/>
              </svg>
              <span class="cpbtn-text">{{ t('filePreview.copy') }}</span>
            </button>
            <span v-if="turn.durationMs !== undefined && turn.role === 'assistant'" class="turn-duration" :title="`${turn.durationMs} ms`">{{ formatDuration(turn.durationMs) }}</span>
          </div>

          <!-- User input renders verbatim (pre-wrap), never through Markdown -->
          <div v-if="turn.role === 'user'" class="u-text">
            <div v-if="turn.skillActivation" class="skill-act">
              <div class="skill-act-head">
                <span class="skill-act-arrow">▶</span>
                <span>{{ t('conversation.activatedSkill', { name: turn.skillActivation.name }) }}</span>
              </div>
              <div v-if="turn.skillActivation.args" class="skill-act-args">{{ turn.skillActivation.args }}</div>
            </div>
            <template v-else>{{ turn.text }}</template>
          </div>

          <!-- Thinking + message text + tool cards, interleaved in original call order. -->
          <template v-else>
            <template v-for="(blk, bi) in assistantRenderBlocks(turn)" :key="renderBlockKey(blk, bi)">
              <ThinkingBlock v-if="blk.kind === 'thinking'" :text="blk.thinking" :streaming="isStreamingRenderBlock(turn, blk)" @open="emit('openThinking', { turnId: turn.id, blockIndex: blk.sourceIndex })" />
              <Markdown v-else-if="blk.kind === 'text' && blk.text" :text="blk.text" :streaming="isStreamingRenderBlock(turn, blk)" :open-file="(target) => emit('openFile', target)" />
              <div v-else-if="blk.kind === 'tool-stack'" class="tool-stack">
                <ToolCall v-for="(item, si) in blk.tools" :key="toolStackKey(item)" :tool="item.tool" :stack-position="toolStackPosition(si, blk.tools.length)" @open-media="emit('openMedia', $event)" />
              </div>
              <AgentCard v-else-if="blk.kind === 'agent'" :member="blk.member" @open="emit('openAgent', { turnId: turn.id, blockIndex: blk.sourceIndex, memberId: $event })" />
              <AgentGroup v-else-if="blk.kind === 'agentGroup'" :members="blk.members" @open="emit('openAgent', { turnId: turn.id, blockIndex: blk.sourceIndex, memberId: $event })" />
              <ToolCall v-else-if="blk.kind === 'tool'" :tool="blk.tool" @open-media="emit('openMedia', $event)" />
            </template>
          </template>
        </div>

        <div
          v-if="turn.role === 'user' && canEditTurn(turn)"
          class="u-edit-wrap ln-edit-wrap"
          :class="{ undoing: undoingTurnId === turn.id }"
        >
          <button
            v-if="confirmingEditTurnId !== turn.id"
            type="button"
            class="u-edit"
            :data-tooltip="t('conversation.undoTooltip')"
            @click="confirmingEditTurnId = turn.id"
          >
            <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6.5 2.5 3 6l3.5 3.5"/>
              <path d="M3 6h6.5a3.8 3.8 0 1 1 0 7.6H7.5"/>
            </svg>
            <span class="u-edit-text">{{ t('conversation.undo') }}</span>
          </button>
          <div v-else class="u-edit-confirm" @click.stop>
            <span>{{ t('conversation.undoConfirm') }}</span>
            <button
              type="button"
              class="u-edit-confirm-btn confirm"
              @click.stop="confirmEditMessage(turn)"
            >
              {{ t('conversation.confirm') }}
            </button>
            <button
              type="button"
              class="u-edit-confirm-btn"
              @click.stop="confirmingEditTurnId = null"
            >
              {{ t('conversation.cancel') }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- Pending approvals as standalone interrupt cards (do not depend on a
         matching tool_use being loaded in the transcript) -->
    <!-- Pending approvals are rendered in the bottom dock (ConversationPane),
         alongside questions, so both blocking prompts share one position. -->

    <!-- Compaction in progress — body-sized moon activity notice -->
    <ActivityNotice v-if="compaction" :label="t('conversation.compacting')" />

    <!-- Working placeholder — moon spinner while the turn is in flight (covers
         a page refresh mid-stream, where `sending` was lost but the session is
         still running). -->
    <div v-if="showWorking" class="ln sending-line">
      <span class="no">—</span>
      <div class="tx">
        <div class="role-row">
          <span class="pr">kimi</span>
          <span class="who"> &gt; </span>
        </div>
        <MoonSpinner :fast="fastMoon" label="Sending…" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.term {
  --chat-turn-gap: 10px;
  --chat-block-gap: 10px;
  --chat-section-gap: 16px;
  padding: 14px 18px 10px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
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
.dot-pulse {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--blue);
  animation: dot-pulse-anim 1.4s ease-in-out infinite;
}
@keyframes dot-pulse-anim {
  0%, 100% { opacity: 0.4; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1); }
}

.ln { display: flex; gap: 11px; margin-bottom: var(--chat-turn-gap); }
.no {
  color: var(--faint);
  width: 22px;
  text-align: right;
  flex: none;
  user-select: none;
  font-size: calc(var(--ui-font-size) - 3px);
  padding-top: 2px;
}
.tx { flex: 1; min-width: 0; }
.tx > :deep(.think),
.tx > :deep(.md),
.tx > .tool-stack,
.tx > :deep(.agent-card),
.tx > :deep(.agent-group),
.tx > :deep(.box),
.tx > :deep(.media-tool) {
  margin-top: var(--chat-block-gap);
}
.tx > :deep(.think:first-child),
.tx > :deep(.md:first-child),
.tx > .tool-stack:first-child,
.tx > :deep(.agent-card:first-child),
.tx > :deep(.agent-group:first-child),
.tx > :deep(.box:first-child),
.tx > :deep(.media-tool:first-child) {
  margin-top: 0;
}

/* Role prefix row */
.role-row {
  display: flex;
  align-items: center;
  gap: 0;
  margin-bottom: 2px;
  position: relative;
}
.userline .pr { color: var(--blue2); font-weight: 700; font-size: calc(var(--ui-font-size) - 1.5px); }
.ai .pr { color: var(--ok); font-weight: 700; font-size: calc(var(--ui-font-size) - 1.5px); }
.who { color: var(--muted); font-size: calc(var(--ui-font-size) - 1.5px); }
.turn-duration {
  display: inline-flex;
  align-items: center;
  margin-left: 8px;
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--muted);
  font-family: var(--mono);
  line-height: 1;
}

/* Copy button: always visible, text shows on hover */
.cpbtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--faint);
  font-size: var(--ui-font-size-sm);
  font-family: var(--mono);
  padding: 0 4px 0 0;
  margin-left: 8px;
}
.cpbtn:hover {
  color: var(--blue);
}
.cpbtn-text {
  opacity: 0;
  max-width: 0;
  overflow: hidden;
  white-space: nowrap;
  transition: opacity 0.15s ease, max-width 0.15s ease;
  cursor: pointer;
}
.cpbtn:hover .cpbtn-text {
  opacity: 1;
  max-width: 120px;
}

/* ===================== Mobile bubble layout ===================== */
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
.chat > .u-bub,
.chat > .a-msg,
.chat > .compact-divider,
.chat > .sending-placeholder,
.chat > :deep(.activity-notice) {
  margin-top: var(--chat-turn-gap);
}
.chat > .a-msg {
  margin-top: 10px;
}
.chat > .u-bub:first-child,
.chat > .a-msg:first-child,
.chat > .compact-divider:first-child,
.chat > .sending-placeholder:first-child,
.chat > :deep(.activity-notice:first-child) {
  margin-top: 0;
}

/* User message → right-aligned soft-blue bubble */
.u-bub {
  align-self: flex-end;
  max-width: 84%;
  background: var(--bluebg);
  border: 1px solid var(--blueln);
  color: var(--ink);
  border-radius: 16px 16px 5px 16px;
  padding: 10px 14px;
  font-size: 15px;
  line-height: 1.55;
}
.u-meta {
  align-self: flex-end;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  max-width: 84%;
  margin-top: 2px;
  margin-right: 4px;
}
.u-meta .u-time {
  display: inline-flex;
  align-items: center;
  padding: 2px 5px;
  background: none;
  border: none;
  border-radius: 5px;
  color: var(--muted);
  font: inherit;
  font-size: calc(var(--ui-font-size) - 3px);
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.12s, color 0.12s, background-color 0.12s;
  white-space: nowrap;
}
.u-meta .u-time:hover {
  opacity: 1;
  color: var(--blue);
  background: var(--hover);
}
.u-meta .u-edit,
.u-meta .u-time {
  min-height: 22px;
  box-sizing: border-box;
}
.u-meta .u-edit svg {
  margin-top: -1.5px;
}
.u-meta .u-edit-text {
  max-width: 0;
  overflow: hidden;
  white-space: nowrap;
  transition: max-width 0.15s ease;
}
.u-meta .u-edit:hover .u-edit-text { max-width: 120px; }
@keyframes undo-bubble-exit {
  0% {
    opacity: 1;
    transform: translateX(0) scale(1);
    filter: blur(0);
  }
  55% {
    opacity: 0.45;
    transform: translateX(10px) scale(0.985);
    filter: blur(0.4px);
  }
  100% {
    opacity: 0;
    transform: translateX(28px) scale(0.92);
    filter: blur(2px);
  }
}
@keyframes undo-line-exit {
  0% {
    opacity: 1;
    transform: translateX(0);
  }
  100% {
    opacity: 0;
    transform: translateX(18px);
  }
}
.u-bub.undoing {
  pointer-events: none;
  transform-origin: right center;
  animation: undo-bubble-exit 240ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
}
.ln.userline.undoing {
  pointer-events: none;
  transform-origin: right center;
  animation: undo-line-exit 240ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
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
  gap: 4px;
  padding: 2px 5px;
  background: none;
  border: none;
  border-radius: 5px;
  color: var(--muted);
  font: inherit;
  font-size: calc(var(--ui-font-size) - 3px);
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.12s, color 0.12s, background-color 0.12s;
}
.u-edit svg {
  display: block;
  flex: none;
}
.u-edit span { line-height: 1; }
.u-edit:hover { opacity: 1; color: var(--blue); background: var(--hover); }
/* Custom tooltip for the undo button: appears faster than the native title
   tooltip and avoids duplicating the browser's long default delay. */
.u-edit[data-tooltip] {
  position: relative;
}
.u-edit[data-tooltip]::after,
.u-edit[data-tooltip]::before {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.12s ease, visibility 0.12s ease;
  transition-delay: 0s;
  z-index: 100;
}
.u-edit[data-tooltip]::after {
  content: attr(data-tooltip);
  bottom: calc(100% + 6px);
  padding: 4px 8px;
  background: var(--ink);
  color: var(--bg);
  font-size: 12px;
  line-height: 1.3;
  border-radius: 5px;
  white-space: nowrap;
}
.u-edit[data-tooltip]::before {
  content: '';
  bottom: calc(100% + 2px);
  border-width: 4px;
  border-style: solid;
  border-color: var(--ink) transparent transparent transparent;
}
.u-edit[data-tooltip]:hover::after,
.u-edit[data-tooltip]:hover::before,
.u-edit[data-tooltip]:focus-visible::after,
.u-edit[data-tooltip]:focus-visible::before {
  opacity: 1;
  visibility: visible;
  transition-delay: 0.25s;
}
/* Mobile bubble layout: right-align the undo button below the bubble. */
.u-edit-wrap { display: flex; justify-content: flex-end; }
.u-edit-wrap.undoing {
  opacity: 0;
  pointer-events: none;
  transform: translateX(12px) scale(0.95);
  transition: opacity 120ms ease, transform 160ms ease;
}
.chat > .u-edit-wrap { margin-top: 4px; }
.chat > .u-edit-wrap + .a-msg { margin-top: 8px; }
/* Desktop line layout: place the affordance after the message text with the
   same icon-only-then-label hover reveal behaviour. */
.ln-edit-wrap {
  flex: none;
  display: flex;
  align-items: flex-start;
  padding-top: 2px;
}
.ln .u-edit-text {
  max-width: 0;
  overflow: hidden;
  white-space: nowrap;
  transition: max-width 0.15s ease;
}
.ln .u-edit:hover .u-edit-text { max-width: 120px; }
/* Inline confirm state shown after the user clicks the undo affordance. */
.u-edit-confirm {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 5px;
  color: var(--muted);
  font: inherit;
  font-size: calc(var(--ui-font-size) - 3px);
  border-radius: 5px;
  background: var(--hover);
}
.u-edit-confirm span { line-height: 1; }
.u-edit-confirm-btn {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: calc(var(--ui-font-size) - 3px);
  line-height: 1;
  color: var(--blue);
  cursor: pointer;
}
.u-edit-confirm-btn:hover { text-decoration: underline; }
.u-edit-confirm-btn.confirm { color: var(--blue); }

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
.term > .compact-divider:first-child,
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
  font-size: calc(var(--ui-font-size) - 1.5px);
  color: var(--muted);
  white-space: nowrap;
}
.cd-btn {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font: inherit;
  font-size: calc(var(--ui-font-size) - 1.5px);
  color: var(--muted);
}
.cd-view { color: var(--blue); }
.cd-btn:hover .cd-view { text-decoration: underline; }

/* Assistant message → left-aligned plain column, no role label */
.a-msg {
  align-self: flex-start;
  max-width: 94%;
  width: 94%;
}
.tool-stack {
  display: flex;
  flex-direction: column;
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
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--muted);
  line-height: 1;
}

.a-cpbtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--faint);
  cursor: pointer;
  font-size: calc(var(--ui-font-size) - 3px);
  padding: 2px 6px 2px 0;
  border-radius: 4px;
}
.a-cpbtn:hover {
  color: var(--ink);
}
.a-cpbtn svg,
.a-cpbtn-text {
  pointer-events: none;
}
.a-cpbtn svg {
  flex: none;
}
.a-cpbtn-text {
  opacity: 0;
  max-width: none;
  overflow: visible;
  white-space: nowrap;
  transition: opacity 0.15s ease;
}
.a-cpbtn:hover .a-cpbtn-text {
  opacity: 1;
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
  /* Desktop line-turns layout on a touch screen (tablets): the hover-revealed
     copy button would otherwise be permanently invisible. */
  .cpbtn {
    opacity: 1;
    pointer-events: auto;
  }
}
.a-msg .msg {
  font-size: var(--ui-font-size);
  line-height: 1.6;
  color: var(--ink);
  font-weight: 500;
}
.a-msg .msg :deep(p) { margin: 0; }
.a-msg .msg :deep(p + p) { margin-top: 8px; }
/* ChatPane owns block spacing; child components own only their internal layout. */
.a-msg > .msg,
.a-msg > :deep(.think),
.a-msg > .tool-stack,
.a-msg > :deep(.agent-card),
.a-msg > :deep(.agent-group),
.a-msg > :deep(.box),
.a-msg > :deep(.media-tool) {
  margin-top: var(--chat-block-gap);
}
.a-msg > .msg:first-child,
.a-msg > :deep(.think:first-child),
.a-msg > .tool-stack:first-child,
.a-msg > :deep(.agent-card:first-child),
.a-msg > :deep(.agent-group:first-child),
.a-msg > :deep(.box:first-child),
.a-msg > :deep(.media-tool:first-child) {
  margin-top: 0;
}
.a-msg :deep(code) {
  font-family: var(--mono);
  font-size: var(--ui-font-size-sm);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 1px 5px;
  color: var(--blue2);
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

/* NOTE: Modern-theme chat/bubble styles live in src/style.css (global). Scoped
   `:global(html[data-theme=modern]) .u-bub` rules here did NOT win the cascade,
   so they were moved to the global sheet. */

/* Mobile bubble layout sending placeholder */
.sending-placeholder {
  align-self: flex-start;
  padding: 10px 0;
}

/* Desktop line-turns sending placeholder */
.sending-line .tx {
  padding-top: 2px;
}

/* Skill activation card (replaces raw <kimi-skill-loaded> XML) */
.skill-act {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.skill-act-head {
  font-size: var(--ui-font-size-sm);
  font-weight: 600;
  color: var(--blue2);
  display: flex;
  align-items: center;
  gap: 6px;
}
.skill-act-arrow {
  color: var(--blue);
  font-size: calc(var(--ui-font-size) - 3px);
}
.skill-act-args {
  font-size: calc(var(--ui-font-size) - 1.5px);
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
  .a-cpbtn-text,
  .cpbtn-text {
    opacity: 1;
    max-width: 120px;
  }
  .u-edit-confirm {
    flex-wrap: wrap;
    justify-content: flex-end;
    max-width: calc(100vw - 28px);
  }
  .userline .pr,
  .ai .pr,
  .who {
    font-size: calc(var(--ui-font-size) + 0.5px);
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

</style>
