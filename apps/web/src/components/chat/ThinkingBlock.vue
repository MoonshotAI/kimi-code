<!-- apps/kimi-web/src/components/chat/ThinkingBlock.vue -->
<!-- Inline collapsible thinking: a quiet disclosure row in the message stream.
     The k15 bulb (Kimi's reasoning glyph) leads the row in every state; while
     streaming the "thinking…" label breathes and elapsed seconds tick beside it
     (renderer-measured, live sessions only), afterwards the label settles to
     "Thinking" with the final span as `· Ns`. ALWAYS collapsed by default —
     there is NO side panel any more; the user expands the row to read the full
     text inline (no internal scroll window, the page scrolls). If the user
     expanded mid-stream, the block folds itself back when the stream moves
     past it. -->
<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/web-ui';
import { formatDuration } from '../chatTurnRendering';

const props = withDefaults(
  defineProps<{
    text: string;
    mobile?: boolean;
    streaming?: boolean;
    /** Renderer-measured timing (live sessions only): when this block opened
        (ISO) and how long it streamed (ms). Absent for history. */
    startedAt?: string;
    durationMs?: number;
  }>(),
  { mobile: false, streaming: false, startedAt: undefined, durationMs: undefined },
);

const open = ref(false);
const { t } = useI18n();

// Thinking is done once the stream moves past this block: fold back even if
// the user expanded it mid-stream, so the transcript settles quiet again.
watch(
  () => props.streaming,
  (now, prev) => {
    if (prev && !now) open.value = false;
  },
);

// Live elapsed seconds while this block streams; the settled duration arrives
// as `durationMs` once the stream moves on.
const nowMs = ref(Date.now());
watch(
  () => [props.streaming, props.startedAt] as const,
  ([streaming, startedAt], _prev, onCleanup) => {
    if (!streaming || !startedAt) return;
    nowMs.value = Date.now();
    const timer = setInterval(() => {
      nowMs.value = Date.now();
    }, 1000);
    onCleanup(() => clearInterval(timer));
  },
  { immediate: true },
);

/** Suffix next to the label: ticking seconds live, settled span when done. */
const elapsedLabel = computed(() => {
  if (props.streaming && props.startedAt) {
    const startMs = Date.parse(props.startedAt);
    return Number.isFinite(startMs) ? formatDuration(nowMs.value - startMs) : '';
  }
  if (props.durationMs !== undefined) {
    const span = formatDuration(props.durationMs);
    return span ? `· ${span}` : '';
  }
  return '';
});

// Settled blocks pin the head after toggling (the ConversationPane pin), so
// collapsing a long body doesn't leave the user stranded. A LIVE block (still
// streaming) skips the pin instead: it keeps growing on its own, and the
// follow — or native anchoring off-follow — absorbs the toggle, so expanding
// mid-stream becomes read-along rather than breaking the follow.
const pinScroll = inject<(el: HTMLElement, ms?: number) => void>('pinScroll', () => {});
const headEl = ref<HTMLElement | null>(null);
const bodyInnerEl = ref<HTMLElement | null>(null);

// Set for a reveal whose content already exceeds the viewport: the 160ms
// grid-rows transition would streak thousands of px, so the reveal (and its
// matching collapse) goes instant instead. Recomputed on every expand.
const instant = ref(false);

function onHeadClick(): void {
  if (!open.value) {
    const tall =
      (bodyInnerEl.value?.scrollHeight ?? 0) >
      (typeof window !== 'undefined' ? window.innerHeight : 0);
    instant.value = props.streaming && tall;
  }
  open.value = !open.value;
  if (props.streaming) return;
  const el = headEl.value;
  if (el) nextTick(() => pinScroll(el));
}
</script>

<template>
  <div class="think" :class="{ mob: mobile, open, streaming }">
    <button ref="headEl" class="think-head" type="button" :aria-expanded="open" @click="onHeadClick">
      <Icon class="think-bulb" name="thinking" size="sm" />
      <span class="think-title">{{ streaming ? t('thinking.streaming') : t('thinking.panelTitle') }}</span>
      <span v-if="elapsedLabel" class="think-time">{{ elapsedLabel }}</span>
      <Icon class="think-car" name="chevron-right" size="sm" />
    </button>
    <div class="think-body" :class="{ open, instant }" :inert="!open">
      <div ref="bodyInnerEl" class="think-body-inner">
        <pre class="think-text">{{ text }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.think {
  margin: 0;
}

/* Borderless quiet row — thinking sits below tool cards in the hierarchy, so
   it gets no card shell, only a text-colour hover (same vocabulary as the old
   teaser, see DesignSystemView §04). */
.think-head {
  display: flex;
  align-items: center;
  /* Icon-to-label internals use the 4px step of the spacing rhythm. */
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-1) 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  /* Decouple the row from the message area's reading line-height: with
     line-height: 1 the text em box and the 14px icon centre exactly. */
  line-height: 1;
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition: color var(--duration-base) var(--ease-out);
}
.think-head:hover {
  color: var(--color-text);
}
.think-head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--color-accent-soft);
}

.think-bulb {
  flex: none;
}

.think-title {
  font-weight: var(--weight-medium);
}

/* Elapsed seconds: metadata weight, stays faint even on head hover (same
   vocabulary as the activity fold row's meta). */
.think-time {
  color: var(--color-text-faint);
  font-weight: 400;
  flex: none;
}

/* While streaming the label breathes (opacity only — the design system bans
   gradient shimmer text); reduced-motion keeps it static. The `.streaming`
   class must be pinned to the think root itself: with a bare descendant
   selector (`.streaming .think-title`), scoped CSS only attaches the data-v
   attribute to `.think-title`, so ANY ancestor carrying `streaming` (e.g.
   TurnFold's root while its turn streams) would make EVERY completed thinking
   row inside breathe too. */
.think.streaming .think-title {
  animation: think-breathe 1.6s var(--ease-in-out) infinite;
}
@keyframes think-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .think.streaming .think-title {
    animation: none;
  }
}

.think-car {
  color: var(--color-text-faint);
  flex: none;
  transition: transform var(--duration-base) var(--ease-out);
}
.think.open .think-car {
  transform: rotate(90deg);
}

/* Same grid-rows collapse as ActivityRun (min-height: 0 lets the track shrink
   below the content's automatic minimum). */
.think-body {
  display: grid;
  grid-template-rows: minmax(0, 0fr);
  overflow: hidden;
  transition: grid-template-rows var(--duration-base) var(--ease-out);
}
/* Instant reveal (see onHeadClick): skip the transition so a very tall live
   body doesn't streak thousands of px across the viewport. */
.think-body.instant {
  transition: none;
}
.think-body.open {
  grid-template-rows: minmax(0, 1fr);
}
.think-body-inner {
  min-height: 0;
  overflow: hidden;
}

.think-text {
  font: var(--text-base)/var(--leading-relaxed) var(--font-ui);
  font-weight: 400;
  color: var(--color-text-muted);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  padding: var(--space-1) 0 var(--space-2);
}

/* ---- Mobile tweaks ---- */
.mob .think-text {
  color: var(--color-text-faint);
  line-height: var(--leading-normal);
}
</style>
