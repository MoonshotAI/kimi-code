<!-- apps/kimi-web/src/components/ChatPane.vue -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatTurn, ApprovalBlock, FilePreviewRequest, ToolMedia, TurnBlock } from '../types';
import ToolCall from './ToolCall.vue';
import Markdown from './Markdown.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import ActivityNotice from './ActivityNotice.vue';
import AgentCard from './AgentCard.vue';
import AgentGroup from './AgentGroup.vue';

const { t } = useI18n();

const MOON_FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const MOON_INTERVAL_MS = 120;

const moonFrame = ref(0);
let moonInterval: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  moonInterval = setInterval(() => {
    moonFrame.value = (moonFrame.value + 1) % MOON_FRAMES.length;
  }, MOON_INTERVAL_MS);
});

onUnmounted(() => {
  if (moonInterval) {
    clearInterval(moonInterval);
    moonInterval = null;
  }
  if (copiedTimer !== null) {
    clearTimeout(copiedTimer);
    copiedTimer = null;
  }
  if (copiedConversationTimer !== null) {
    clearTimeout(copiedConversationTimer);
    copiedConversationTimer = null;
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
  { approvals: () => [], bubble: false, mobile: false, running: false, sending: false, compaction: null },
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
}>();

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
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

// Copy-whole-conversation state
const copiedConversation = ref(false);
let copiedConversationTimer: ReturnType<typeof setTimeout> | null = null;

/** Assemble the full content of a turn for copying — follows the ordered
    blocks so thinking/text/tool output copy in the order they happened. */
function turnPlainText(turn: ChatTurn): string {
  const parts: string[] = [];
  for (const blk of turnBlocks(turn)) {
    if (blk.kind === 'thinking' && blk.thinking) parts.push(blk.thinking);
    else if (blk.kind === 'text' && blk.text) parts.push(blk.text);
    else if (blk.kind === 'tool' && blk.tool.output && blk.tool.output.length > 0) {
      parts.push(`[${blk.tool.name}]\n${blk.tool.output.join('\n')}`);
    } else if (blk.kind === 'agent') {
      parts.push(`[agent] ${blk.member.name} - ${blk.member.phase}${blk.member.summary ? `\n${blk.member.summary}` : ''}`);
    } else if (blk.kind === 'agentGroup') {
      parts.push(
        `[agents]\n${blk.members
          .map((member) => `- ${member.name}: ${member.phase}${member.summary ? ` - ${member.summary}` : ''}`)
          .join('\n')}`,
      );
    }
  }
  return parts.join('\n\n');
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

defineExpose({ copyConversation });

function assistantRunEndingAt(index: number): ChatTurn[] {
  const run: ChatTurn[] = [];
  for (let i = index; i >= 0; i--) {
    const turn = props.turns[i];
    if (!turn || turn.role !== 'assistant') break;
    run.unshift(turn);
  }
  return run;
}

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
  const text = assistantRunEndingAt(index)
    .map((t) => turnPlainText(t))
    .filter(Boolean)
    .join('\n\n');
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
      <!-- User turn → right-aligned soft-blue bubble -->
      <div v-if="turn.role === 'user'" class="u-bub">
        <!-- Image attachments -->
        <div v-if="turn.images && turn.images.length > 0" class="u-imgs">
          <img
            v-for="(img, ii) in turn.images"
            :key="ii"
            class="u-img"
            :src="img.url"
            :alt="img.alt || ''"
            loading="lazy"
          />
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

      <!-- Compaction divider — prior turns stay untouched; summary opens in
           the right-side panel on click. -->
      <div v-else-if="turn.role === 'compaction'" class="compact-divider" role="separator">
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
      <div v-else class="a-msg">
        <template v-for="(blk, bi) in assistantRenderBlocks(turn)" :key="renderBlockKey(blk, bi)">
          <ThinkingBlock v-if="blk.kind === 'thinking'" :text="blk.thinking" :mobile="childBubble" :streaming="isStreamingRenderBlock(turn, blk)" @open="emit('openThinking', { turnId: turn.id, blockIndex: blk.sourceIndex })" />
          <div v-else-if="blk.kind === 'text' && blk.text" class="msg"><Markdown :text="blk.text" :streaming="isStreamingRenderBlock(turn, blk)" :open-file="(target) => emit('openFile', target)" /></div>
          <div v-else-if="blk.kind === 'tool-stack'" class="tool-stack">
            <ToolCall v-for="(item, si) in blk.tools" :key="toolStackKey(item)" :tool="item.tool" :mobile="childBubble" :stack-position="toolStackPosition(si, blk.tools.length)" @open-media="emit('openMedia', $event)" />
          </div>
          <AgentCard v-else-if="blk.kind === 'agent'" :member="blk.member" />
          <AgentGroup v-else-if="blk.kind === 'agentGroup'" :members="blk.members" />
          <ToolCall v-else-if="blk.kind === 'tool'" :tool="blk.tool" :mobile="childBubble" @open-media="emit('openMedia', $event)" />
        </template>
        <div v-if="turn.id !== streamingTurnId && isAssistantRunEnd(ti)" class="a-msg-ft">
          <button
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
      <span class="moon-spin" aria-label="Working…">{{ MOON_FRAMES[moonFrame] }}</span>
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
      <div v-if="turn.role === 'compaction'" class="compact-divider" role="separator">
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

      <div v-else class="ln" :class="turn.role === 'user' ? 'userline' : 'ai'">
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
            <button v-if="turn.id !== streamingTurnId && isAssistantRunEnd(ti)" class="cpbtn" @click="copyAssistantRun(ti)" tabindex="-1">
              <svg v-if="copiedTurn !== turn.id" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="9" height="9" rx="1.5"/>
                <path d="M6 1h7a1 1 0 0 1 1 1v7"/>
              </svg>
              <svg v-else viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="3,8 6.5,11.5 13,5"/>
              </svg>
              <span class="cpbtn-text">{{ t('filePreview.copy') }}</span>
            </button>
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
              <AgentCard v-else-if="blk.kind === 'agent'" :member="blk.member" />
              <AgentGroup v-else-if="blk.kind === 'agentGroup'" :members="blk.members" />
              <ToolCall v-else-if="blk.kind === 'tool'" :tool="blk.tool" @open-media="emit('openMedia', $event)" />
            </template>
          </template>
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
        <span class="moon-spin" aria-label="Sending…">{{ MOON_FRAMES[moonFrame] }}</span>
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
.chat-empty-text { font-size: 13px; }

.chat-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 16px;
  color: var(--muted);
}
.chat-loading-text { font-size: 13px; }
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
  font-size: 11px;
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
.userline .pr { color: var(--blue2); font-weight: 700; font-size: 12.5px; }
.ai .pr { color: var(--ok); font-weight: 700; font-size: 12.5px; }
.who { color: var(--muted); font-size: 12.5px; }

/* Copy button: always visible, text shows on hover */
.cpbtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--faint);
  font-size: 13px;
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
  font-size: 14px;
  line-height: 1.55;
}
/* User input is shown verbatim — preserve newlines, break long tokens. */
.u-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

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
  font-size: 12.5px;
  color: var(--muted);
  white-space: nowrap;
}
.cd-btn {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font: inherit;
  font-size: 12.5px;
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
  height: auto;
  margin-top: var(--chat-block-gap);
  overflow: visible;
}

.a-cpbtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--faint);
  cursor: pointer;
  font-size: 11px;
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
    font-size: 13px;
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
  font-size: 14px;
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
.a-msg > :deep(.box),
.a-msg > :deep(.media-tool) {
  margin-top: var(--chat-block-gap);
}
.a-msg > .msg:first-child,
.a-msg > :deep(.think:first-child),
.a-msg > .tool-stack:first-child,
.a-msg > :deep(.box:first-child),
.a-msg > :deep(.media-tool:first-child) {
  margin-top: 0;
}
.a-msg :deep(code) {
  font-family: var(--mono);
  font-size: 13px;
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

/* ---- Moon spinner — shown while the prompt is in flight ---- */
.moon-spin {
  display: inline-block;
  font-size: 14px;
  line-height: 1;
  user-select: none;
}

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
  font-size: 13px;
  font-weight: 600;
  color: var(--blue2);
  display: flex;
  align-items: center;
  gap: 6px;
}
.skill-act-arrow {
  color: var(--blue);
  font-size: 11px;
}
.skill-act-args {
  font-size: 12.5px;
  color: var(--muted);
  padding-left: 17px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Mobile font bump (+2px) */
@media (max-width: 640px) {
  .u-bub .u-text,
  .a-msg .msg {
    font-size: 16px;
  }
  .userline .pr,
  .ai .pr,
  .who {
    font-size: 14.5px;
  }
  .ts {
    font-size: 13px;
  }
  .chat-empty-text,
  .chat-loading-text {
    font-size: 15px;
  }
  .cd-label,
  .cd-btn {
    font-size: 14px;
  }
}

</style>
