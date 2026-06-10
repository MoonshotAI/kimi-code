<!-- apps/kimi-web/src/components/ChatPane.vue -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatTurn, ApprovalBlock, TurnBlock } from '../types';

const { t } = useI18n();
import type { ApprovalDecision } from '../api/types';
import ToolCall from './ToolCall.vue';
import ApprovalCard from './ApprovalCard.vue';
import Markdown from './Markdown.vue';
import ThinkingBlock from './ThinkingBlock.vue';

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
  }>(),
  { approvals: () => [], bubble: false, mobile: false, running: false, sending: false },
);

// Bubble layout is active on phones AND on the Modern desktop theme. ThinkingBlock
// / ToolCall use their soft "bubble" rendering in the same condition.
const childBubble = computed(() => props.bubble || props.mobile);

// The id of the turn that is actively streaming: the last assistant turn while
// the session is running. Its Markdown renders with `streaming` (final=false);
// every other turn renders statically.
const streamingTurnId = computed<string | null>(() => {
  if (!props.running || props.turns.length === 0) return null;
  const last = props.turns[props.turns.length - 1]!;
  return last.role === 'assistant' ? last.id : null;
});

const emit = defineEmits<{
  approvalDecide: [approvalId: string, response: { decision: ApprovalDecision; scope?: 'session'; feedback?: string }];
}>();

// Per-turn copy button state (keyed by turn id)
const copiedTurn = ref<string | null>(null);

function copyTurn(turn: ChatTurn) {
  navigator.clipboard.writeText(turn.text).then(() => {
    copiedTurn.value = turn.id;
    setTimeout(() => { copiedTurn.value = null; }, 1400);
  }).catch(() => {/* ignore */});
}

// Ordered render blocks for an assistant turn. messagesToTurns supplies `blocks`
// (text + tool cards in call order); fall back to deriving them from text+tools
// for any turn built without blocks (e.g. unit tests).
function turnBlocks(turn: ChatTurn): TurnBlock[] {
  if (turn.blocks) return turn.blocks;
  const blocks: TurnBlock[] = [];
  if (turn.text) blocks.push({ kind: 'text', text: turn.text });
  for (const tool of turn.tools ?? []) blocks.push({ kind: 'tool', tool });
  return blocks;
}
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
    <div v-else-if="turns.length === 0 && (!approvals || approvals.length === 0)" class="chat-empty">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
      <div class="chat-empty-text">{{ t('composer.emptyConversation') }}</div>
    </div>

    <template v-for="turn in turns" :key="turn.id">
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
        <Markdown :text="turn.text" />
      </div>

      <!-- Assistant turn → left-aligned, no name/role label -->
      <div v-else class="a-msg">
        <ThinkingBlock v-if="turn.thinking" :text="turn.thinking" :mobile="childBubble" :streaming="turn.id === streamingTurnId" />
        <template v-for="(blk, bi) in turnBlocks(turn)" :key="bi">
          <div v-if="blk.kind === 'text' && blk.text" class="msg"><Markdown :text="blk.text" :streaming="turn.id === streamingTurnId && bi === turnBlocks(turn).length - 1" /></div>
          <ToolCall v-else-if="blk.kind === 'tool'" :tool="blk.tool" :mobile="childBubble" />
        </template>
        <div class="a-msg-ft">
          <button
            class="a-cpbtn"
            :title="t('filePreview.copy')"
            @click="copyTurn(turn)"
          >
            {{ copiedTurn === turn.id ? '✓' : '⧉' }} {{ t('filePreview.copy') }}
          </button>
        </div>
      </div>
    </template>

    <ApprovalCard
      v-for="a in approvals"
      :key="a.approvalId"
      :block="a.block"
      :agent-name="a.agentName"
      @decide="(response) => emit('approvalDecide', a.approvalId, response)"
    />

    <!-- Sending placeholder — moon spinner while the request is in flight -->
    <div v-if="sending" class="sending-placeholder">
      <span class="moon-spin" aria-label="Sending…">{{ MOON_FRAMES[moonFrame] }}</span>
    </div>
  </div>

  <!-- ===================== DESKTOP: line-turns ===================== -->
  <div v-else class="term">
    <!-- Loading state: shown while fetching a historical session's turns -->
    <div v-if="sessionLoading" class="chat-loading">
      <span class="dot-pulse" aria-hidden="true" />
      <span class="chat-loading-text">{{ t('conversation.loading') }}</span>
    </div>
    <!-- Empty state: a fresh/empty session shows a hint instead of a blank pane -->
    <div v-else-if="turns.length === 0 && (!approvals || approvals.length === 0)" class="chat-empty">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
      <div class="chat-empty-text">{{ t('composer.emptyConversation') }}</div>
    </div>

    <template v-for="turn in turns" :key="turn.id">
      <div class="ln" :class="turn.role === 'user' ? 'userline' : 'ai'">
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

            <!-- Per-message copy button (shown on hover) -->
            <button class="cpbtn" @click="copyTurn(turn)" :title="t('filePreview.copy')" tabindex="-1">
              {{ copiedTurn === turn.id ? '✓' : '⧉' }}
            </button>
          </div>

          <!-- Thinking block (before the message text) -->
          <ThinkingBlock v-if="turn.thinking" :text="turn.thinking" :streaming="turn.id === streamingTurnId" />

          <!-- Message text + tool cards, interleaved in original call order -->
          <template v-for="(blk, bi) in turnBlocks(turn)" :key="bi">
            <Markdown v-if="blk.kind === 'text' && blk.text" :text="blk.text" :streaming="turn.id === streamingTurnId && bi === turnBlocks(turn).length - 1" />
            <ToolCall v-else-if="blk.kind === 'tool'" :tool="blk.tool" />
          </template>
        </div>
      </div>
    </template>

    <!-- Pending approvals as standalone interrupt cards (do not depend on a
         matching tool_use being loaded in the transcript) -->
    <ApprovalCard
      v-for="a in approvals"
      :key="a.approvalId"
      :block="a.block"
      :agent-name="a.agentName"
      @decide="(response) => emit('approvalDecide', a.approvalId, response)"
    />

    <!-- Sending placeholder — moon spinner while the request is in flight -->
    <div v-if="sending" class="ln sending-line">
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

.ln { display: flex; gap: 11px; margin-bottom: 10px; }
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

/* Copy button: hidden by default, shown on hover of .ln */
.cpbtn {
  margin-left: auto;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--faint);
  font-size: 13px;
  font-family: var(--mono);
  padding: 0 4px;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.1s;
}
.ln:hover .cpbtn {
  opacity: 1;
}
.cpbtn:hover {
  color: var(--blue);
}

/* ===================== Mobile bubble layout ===================== */
.chat {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 16px 14px 20px;
  flex: 1;
  min-height: 0;
}
.chat .chat-empty { align-self: stretch; }

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
/* Markdown inside a user bubble: tighten margins + tint inline code. */
.u-bub :deep(p) { margin: 0; }
.u-bub :deep(p + p) { margin-top: 6px; }
.u-bub :deep(code) {
  font-family: var(--mono);
  font-size: 13px;
  background: rgba(21, 101, 192, 0.09);
  border: none;
  border-radius: 5px;
  padding: 1px 5px;
  color: var(--blue2);
}

/* Assistant message → left-aligned plain column, no role label */
.a-msg {
  align-self: flex-start;
  max-width: 94%;
  width: 94%;
}
.a-msg-ft {
  display: flex;
  margin-top: 6px;
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
  padding: 2px 6px;
  border-radius: 4px;
  line-height: 1;
}
.a-cpbtn:hover {
  background: var(--soft);
  color: var(--ink);
}
.a-msg .msg {
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink);
  font-weight: 500;
}
.a-msg .msg :deep(p) { margin: 0; }
.a-msg .msg :deep(p + p) { margin-top: 8px; }
/* Each block gets 8px top spacing, except the very first child sits flush. */
.a-msg > .msg { margin-top: 12px; }
.a-msg > .msg:first-child { margin-top: 0; }
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
  padding: 10px 14px;
}

/* Desktop line-turns sending placeholder */
.sending-line .tx {
  padding-top: 2px;
}

/* Mobile font bump (+2px) */
@media (max-width: 640px) {
  .u-bub .msg,
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
}
</style>
