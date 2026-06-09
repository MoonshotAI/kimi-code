<!-- apps/kimi-web/src/components/ChatPane.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatTurn, ApprovalBlock } from '../types';

const { t } = useI18n();
import type { ApprovalDecision } from '../api/types';
import ToolCall from './ToolCall.vue';
import ApprovalCard from './ApprovalCard.vue';
import Markdown from './Markdown.vue';
import ThinkingBlock from './ThinkingBlock.vue';

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
  }>(),
  { approvals: () => [], bubble: false, mobile: false, running: false },
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
</script>

<template>
  <!-- ===================== MOBILE: chat bubbles ===================== -->
  <!-- Same ChatTurn data as desktop, rendered as bubbles. User turns are
       right-aligned soft-blue bubbles (no `user@kimi $` prefix, no line number);
       assistant turns are left-aligned plain text with NO role/name label,
       showing in order: thinking → message text → tool cards. -->
  <div v-if="childBubble" class="chat">
    <div v-if="turns.length === 0 && (!approvals || approvals.length === 0)" class="chat-empty">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
      <div class="chat-empty-text">{{ t('composer.emptyConversation') }}</div>
    </div>

    <template v-for="turn in turns" :key="turn.id">
      <!-- User turn → right-aligned soft-blue bubble -->
      <div v-if="turn.role === 'user'" class="u-bub">
        <Markdown :text="turn.text" />
      </div>

      <!-- Assistant turn → left-aligned, no name/role label -->
      <div v-else class="a-msg">
        <ThinkingBlock v-if="turn.thinking" :text="turn.thinking" :mobile="childBubble" />
        <div v-if="turn.text" class="msg"><Markdown :text="turn.text" :streaming="turn.id === streamingTurnId" /></div>
        <ToolCall v-for="tool in turn.tools" :key="tool.id" :tool="tool" :mobile="childBubble" />
      </div>
    </template>

    <ApprovalCard
      v-for="a in approvals"
      :key="a.approvalId"
      :block="a.block"
      :agent-name="a.agentName"
      @decide="(response) => emit('approvalDecide', a.approvalId, response)"
    />
  </div>

  <!-- ===================== DESKTOP: line-turns ===================== -->
  <div v-else class="term">
    <!-- Empty state: a fresh/empty session shows a hint instead of a blank pane -->
    <div v-if="turns.length === 0 && (!approvals || approvals.length === 0)" class="chat-empty">
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
          <ThinkingBlock v-if="turn.thinking" :text="turn.thinking" />

          <!-- Message text rendered as Markdown -->
          <Markdown :text="turn.text" :streaming="turn.id === streamingTurnId" />
        </div>
      </div>

      <!-- Tool cards -->
      <ToolCall v-for="tool in turn.tools" :key="tool.id" :tool="tool" />
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
  </div>
</template>

<style scoped>
.term { padding: 14px 18px 10px; }
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 64px 16px;
  color: var(--faint);
  text-align: center;
}
.chat-empty-text { font-size: 13px; }
.ln { display: flex; gap: 11px; margin-bottom: 6px; }
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
  gap: 15px;
  padding: 16px 14px 20px;
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
  font-size: 12px;
  line-height: 1.55;
}
/* Markdown inside a user bubble: tighten margins + tint inline code. */
.u-bub :deep(p) { margin: 0; }
.u-bub :deep(p + p) { margin-top: 6px; }
.u-bub :deep(code) {
  font-family: var(--mono);
  font-size: 11.5px;
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
.a-msg .msg {
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink);
}
.a-msg .msg :deep(p) { margin: 0; }
.a-msg .msg :deep(p + p) { margin-top: 8px; }
/* Each block gets 8px top spacing, except the very first child sits flush. */
.a-msg > .msg { margin-top: 8px; }
.a-msg > .msg:first-child { margin-top: 0; }
.a-msg :deep(code) {
  font-family: var(--mono);
  font-size: 11.5px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 1px 5px;
  color: var(--blue2);
}

/* ===================== Modern theme ===================== */
/* Softer bubble palette + a subtle shadow, and a smooth fade+slide entrance for
   each turn. The animation runs once on mount (replays only if the last item
   re-renders, which is acceptable). Reduced-motion is disabled globally. */
:global(html[data-theme="modern"]) .chat {
  gap: 18px;
  padding: 22px 20px 26px;
}
/* User bubble → soft Kimi-blue chat bubble (the "your message" colour used
   across the app), generous radius, lifts off the canvas with a faint shadow. */
:global(html[data-theme="modern"]) .u-bub {
  background: var(--bluebg);
  border-color: var(--blueln);
  border-radius: 18px 18px 6px 18px;
  padding: 11px 15px;
  box-shadow: var(--shc);
  animation: kimi-bubble-in 0.24s ease-out both;
}
/* Assistant → plain column on the canvas (no card), just the smooth entrance. */
:global(html[data-theme="modern"]) .a-msg {
  max-width: 100%;
  width: 100%;
  animation: kimi-bubble-in 0.24s ease-out both;
}
</style>
