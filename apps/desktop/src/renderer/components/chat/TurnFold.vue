<!-- Turn-level fold (the second folding level above the activity run): once an
     assistant turn settles, everything BEFORE its final text block — thinking
     segments, quiet tool lines, interim text, standalone cards — folds into a
     single "worked Ns" row, leaving only the final
     answer on screen. The row is a bare faint text line with a rotating
     chevron (no glyph), sharing the activity-run head's padding and hover
     language; the expanded body is the folded blocks themselves, in order,
     each with its own rendering intact.

     While the turn streams the head stays hidden and the body is forced open
     (the transcript looks exactly as it always has); the moment the stream
     moves past this turn — or the turn parks on an approval/question — the
     row appears and folds itself back.

     The "worked Ns" span is DERIVED, never a wall-clock accumulator (see
     turnWorkMs): stamped thinking starts open the clock, the daemon's own
     turn duration or the server message stamps close it. The span is the
     turn's ELAPSED time — approval/question waits are part of it by design,
     so the number is always consistent and needs no park bookkeeping at all;
     the wall clock only feeds the live tick, every settled value derives from
     stamps, so throttled tabs, session switches and remounts cannot corrupt
     it. History turns read the span straight from the server stamps. The fold
     state is a plain component ref — nothing persists, switching sessions
     resets to folded. Folded bodies UNMOUNT once the collapse transition
     ends — a long-lived window must not carry every settled turn's component
     tree (transcript find already skips collapsed bodies via the inert
     filter, so nothing observable changes); expanding remounts closed and
     flips open a frame later so the grid-rows animation still plays. -->
<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { Markdown } from '@moonshot-ai/app-markdown';
import ThinkingBlock from './ThinkingBlock.vue';
import ActivityRun from './ActivityRun.vue';
import ToolCall from './ToolCall.vue';
import NotificationCard from './NotificationCard.vue';
import { formatDuration, renderBlockKey, turnWorkMs } from '@moonshot-ai/app-components';
import type { AssistantRenderBlock } from '@moonshot-ai/app-components';
import type { FilePreviewRequest, OpenMediaRequest } from '../../types';

const props = withDefaults(
  defineProps<{
    items: AssistantRenderBlock[];
    mobile?: boolean;
    /** Non-null while this turn is actively producing: the sourceIndex of the
        turn's last block, so the block sitting on the tail keeps its
        streaming rendering inside the fold body. Null = settled or parked. */
    streamingTailIndex?: number | null;
    /** True while the turn holds the main streaming slot, parked or not. */
    live?: boolean;
    /** True while a live turn waits on the user (approval/question): the row
        shows with the body folded while the elapsed span keeps ticking. */
    parked?: boolean;
    /** Stamped start of the turn's work (epoch ms): the earliest thinking
        block's streaming-open stamp (live sessions only). */
    seedMs?: number;
    /** Server-stamped start of the turn's first message (epoch ms) — the
        start fallback, and the only start for history turns. */
    createdMs?: number;
    /** Server-stamped end of the turn's last message (epoch ms) — the end
        stamp fallback once the turn settles. */
    endedMs?: number;
    /** The daemon's own end-to-end turn measurement (epoch ms), present once
        the turn ends — the preferred settle-time span. */
    durationMs?: number;
  }>(),
  {
    mobile: false,
    streamingTailIndex: null,
    live: false,
    parked: false,
    seedMs: undefined,
    createdMs: undefined,
    endedMs: undefined,
    durationMs: undefined,
  },
);

const emit = defineEmits<{
  openMedia: [payload: OpenMediaRequest];
  openFile: [target: FilePreviewRequest];
  openAgent: [toolCallId: string];
}>();

const { t } = useI18n();

/** Display streaming: the turn is actively producing — head hidden, body
    forced open. Distinct from `live`: a parked turn is still live but reads
    as settled on screen. */
const streaming = computed(() => props.streamingTailIndex !== null);

const phase = computed<'live' | 'parked' | 'settled'>(() => {
  if (!props.live) return 'settled';
  return props.parked ? 'parked' : 'live';
});

// Collapsed by default; the default applies only at mount, manual toggles
// stick (the activity run's vocabulary). While live the body is forced open.
const open = ref(false);
const effectiveOpen = computed(() => streaming.value || open.value);

// A folded body UNMOUNTS instead of idling in the DOM: in a long-lived
// window every settled turn's markdown/tool component tree would otherwise
// stay mounted and reactive forever, and every transcript-wide re-render
// walks that ever-growing tree. Transcript find already skips collapsed
// bodies (the [inert] filter in transcriptSearch), so unmounting changes
// nothing observable. The body mounts closed and flips open a frame later so
// the grid-rows transition still plays; on close it unmounts once the
// collapse transition has ended.
const bodyMounted = ref(effectiveOpen.value);
const bodyOpen = ref(effectiveOpen.value);
let unmountTimer: ReturnType<typeof setTimeout> | null = null;

watch(effectiveOpen, (now) => {
  if (now) {
    if (unmountTimer !== null) {
      clearTimeout(unmountTimer);
      unmountTimer = null;
    }
    if (bodyMounted.value) {
      bodyOpen.value = true;
      return;
    }
    bodyMounted.value = true;
    // Flip the class one frame after mounting closed, or the 0fr→1fr
    // transition never runs on a fresh mount.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bodyOpen.value = true;
      });
    });
    return;
  }
  bodyOpen.value = false;
  // Timer instead of transitionend: reduced-motion kills the transition, so
  // the event may never fire. 200ms = --duration-base (160ms) + slack.
  unmountTimer = setTimeout(() => {
    unmountTimer = null;
    bodyMounted.value = false;
  }, 200);
});

const pinScroll = inject<(el: HTMLElement, ms?: number) => void>('pinScroll', () => {});
const headEl = ref<HTMLElement | null>(null);

// The span is the turn's ELAPSED time (turnWorkMs): a live tick while the
// turn is open — parked included, the wait is part of the span by design —
// and a stamped value once it ends. The tick is the only client-side state.
const nowMs = ref(Date.now());

let tick: ReturnType<typeof setInterval> | null = null;
function stopTick(): void {
  if (tick !== null) {
    clearInterval(tick);
    tick = null;
  }
}
onUnmounted(() => {
  stopTick();
  if (unmountTimer !== null) clearTimeout(unmountTimer);
});

watch(
  phase,
  (now, prev) => {
    // The tick runs while the turn is open, parked or not; it stops for good
    // once the turn settles (the stamped end value takes over).
    if (now !== 'settled') {
      nowMs.value = Date.now();
      if (tick === null) {
        tick = setInterval(() => {
          nowMs.value = Date.now();
        }, 1000);
      }
    } else {
      stopTick();
    }
    // Leaving the live phase folds the body back. This auto-fold is not a user
    // toggle, so it carries no scroll pin: the follow (or native
    // overflow-anchor off-follow) absorbs the height change.
    if (prev === 'live' && now !== 'live') {
      open.value = false;
    }
  },
  { immediate: true },
);

/** Stamped start of the turn's work: the EARLIER of the available stamps —
    an interim text block can precede the first timed thinking, and its
    production time folds away with it. */
const startMs = computed(() => {
  if (props.seedMs === undefined) return props.createdMs;
  if (props.createdMs === undefined) return props.seedMs;
  return Math.min(props.seedMs, props.createdMs);
});

const spanMs = computed(() =>
  turnWorkMs({
    startMs: startMs.value,
    endedMs: props.endedMs,
    durationMs: props.durationMs,
    state:
      phase.value === 'settled'
        ? { phase: 'settled' }
        : { phase: 'live', nowMs: nowMs.value },
  }),
);

function toggle(): void {
  open.value = !open.value;
  void nextTick(() => {
    const el = headEl.value;
    if (el) pinScroll(el);
  });
}

const label = computed(() => {
  const duration = spanMs.value === undefined ? '' : formatDuration(spanMs.value);
  return duration ? t('conversation.fold.worked', { duration }) : t('conversation.fold.workedUnknown');
});

/** A block streams while it sits on the turn's live tail. A settled thinking
    block is done even while still the tail — the turn is parked on an
    approval/question. */
function isBlockStreaming(block: { sourceIndex: number; kind?: string; durationMs?: number }): boolean {
  if (props.streamingTailIndex === null) return false;
  if (block.kind === 'thinking' && block.durationMs !== undefined) return false;
  return block.sourceIndex === props.streamingTailIndex;
}

/** An activity run streams while its last item sits on the turn's live tail,
    so further steps append into this same run. A settled thinking tail means
    the turn parked on an approval/question. */
function isRunStreaming(block: { items: { sourceIndex: number; kind?: string; durationMs?: number }[] }): boolean {
  if (props.streamingTailIndex === null) return false;
  const last = block.items.at(-1);
  if (last?.kind === 'thinking' && last.durationMs !== undefined) return false;
  return last !== undefined && last.sourceIndex === props.streamingTailIndex;
}
</script>

<template>
  <!-- Renders nothing until the turn has folded content — an empty wrapper
       would steal .a-msg's first-child slot and break the stream's spacing
       reset. The work clock needs no early mount: its start is stamped
       (thinking startedAt / the first message's server created_at), so a
       text-first turn still measures from turn start when this mounts. -->
  <div v-if="items.length > 0" class="turn-fold" :class="{ open: effectiveOpen, streaming }">
    <button
      v-if="!streaming"
      ref="headEl"
      class="tf-head"
      type="button"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="tf-sum" :title="label">{{ label }}</span>
      <Icon class="tf-car" name="chevron-right" size="sm" aria-hidden="true" />
    </button>
    <div v-if="bodyMounted" class="tf-body" :class="{ open: bodyOpen }" :inert="!effectiveOpen">
      <div class="tf-body-inner">
        <template v-for="(blk, bi) in items" :key="renderBlockKey(blk, bi)">
          <ThinkingBlock
            v-if="blk.kind === 'thinking'"
            :text="blk.thinking"
            :mobile="mobile"
            :streaming="isBlockStreaming(blk)"
            :started-at="blk.startedAt"
            :duration-ms="blk.durationMs"
          />
          <div v-else-if="blk.kind === 'text' && blk.text" class="msg">
            <Markdown
              :text="blk.text"
              :streaming="isBlockStreaming(blk)"
              :open-file="(target) => emit('openFile', target)"
            />
          </div>
          <ActivityRun
            v-else-if="blk.kind === 'activity-run'"
            :items="blk.items"
            :mobile="mobile"
            :streaming="isRunStreaming(blk)"
            @open-media="emit('openMedia', $event)"
            @open-file="emit('openFile', $event)"
            @open-agent="emit('openAgent', $event)"
          />
          <ToolCall
            v-else-if="blk.kind === 'tool'"
            :tool="blk.tool"
            :mobile="mobile"
            @open-media="emit('openMedia', $event)"
            @open-file="emit('openFile', $event)"
            @open-agent="emit('openAgent', $event)"
          />
          <NotificationCard v-else-if="blk.kind === 'notification'" :items="blk.items" />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.turn-fold {
  display: flex;
  flex-direction: column;
}

/* Head row — the activity-run head's language minus the glyph: borderless
   faint text row (text-colour hover only, no wash), one whole-row button,
   chevron rotating 90°, the same 8px vertical padding (30px row) so the
   turn-level summary keeps its presence between prose paragraphs. */
.tf-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-2) 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  /* Same as the thinking row: decouple from the reading line-height so the
     text em box and the chevron centre exactly. */
  line-height: 1;
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition: color var(--duration-base) var(--ease-out);
}
.tf-head:hover {
  color: var(--color-text);
}
.tf-head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--color-accent-soft);
}

/* The "worked Ns" label rides at the row's faint rung and truncates to one
   line with an ellipsis; the title tooltip carries the full text. */
.tf-sum {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--weight-regular);
}
.tf-car {
  color: var(--color-text-faint);
  flex: none;
  transition: transform var(--duration-base) var(--ease-out);
}
.turn-fold.open .tf-car {
  transform: rotate(90deg);
}

/* Expanded body: grid-rows animation. Block spacing mirrors the chat stream
   exactly — the stream gives every top-level block `margin-top:
   var(--chat-block-gap)` (ChatPane owns block spacing, so the fold body owns
   it for its own blocks); the head row takes the predecessor slot, so even
   the first block keeps its gap. No flex gap, no extra inset: the expanded
   fold must read pixel-identical to the unfolded stream. */
.tf-body {
  display: grid;
  grid-template-rows: minmax(0, 0fr);
  overflow: hidden;
  transition: grid-template-rows var(--duration-base) var(--ease-out);
}
.tf-body.open {
  grid-template-rows: minmax(0, 1fr);
}
.tf-body-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.tf-body-inner > .msg,
.tf-body-inner > :deep(.think),
.tf-body-inner > :deep(.tool-group),
.tf-body-inner > :deep(.activity-run),
.tf-body-inner > :deep(.agent-card),
.tf-body-inner > :deep(.agent-group),
.tf-body-inner > :deep(.tool-line),
.tf-body-inner > :deep(.swarm-card),
.tf-body-inner > :deep(.media-tool),
.tf-body-inner > :deep(.ask-receipt) {
  margin-top: var(--chat-block-gap);
}
/* While the turn streams the head is hidden and the fold body may hold the
   turn's LEADING blocks — mirror the stream's first-child reset so the live
   transcript keeps its exact spacing. */
.turn-fold.streaming .tf-body-inner > .msg:first-child,
.turn-fold.streaming .tf-body-inner > :deep(.think:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.tool-group:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.activity-run:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.agent-card:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.agent-group:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.tool-line:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.swarm-card:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.media-tool:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.ask-receipt:first-child) {
  margin-top: 0;
}

/* Chat prose for folded text — ChatPane's scoped `.a-msg .msg` rules cannot
   cross into this child component, so the fold body mirrors them: the same
   typography, paragraph resets, wide-table behaviour and mobile bump. */
.tf-body-inner .msg {
  font-size: var(--ui-font-size);
  line-height: var(--leading-prose);
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
.tf-body-inner .msg :deep(p) { margin: 0; }
.tf-body-inner .msg :deep(p + p) { margin-top: var(--space-2); }

@container (min-width: 760px) {
  .tf-body-inner .msg :deep(.markstream-vue.markdown-renderer:has(.table-node-wrapper.md-table-wide)) {
    content-visibility: visible;
  }
  .tf-body-inner .msg :deep(.table-node-wrapper.md-table-wide) {
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
  .tf-body-inner .msg :deep(.table-node-wrapper:not(.md-table-wide)) {
    --table-cell-cap: min(var(--p-table-cell-max), 36cqi);
  }
}

</style>
