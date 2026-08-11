<!-- apps/kimi-web/src/components/chat/ActivityRun.vue -->
<!-- A run of consecutive activity (thinking segments + tool calls of any
     kind, cards included) folded into ONE disclosure row. The row leads with
     a status glyph
     (check / close once settled, the current step's own icon breathing while
     running) and narrates the run as a smart summary sentence — per-kind
     done-tense clauses in first-appearance order, a danger failure clause on
     the failing kind, the total span faint at the tail (see
     lib/activitySummary.ts). Thinking items fold into the run but are not
     narrated in the sentence. One line, ellipsis-truncated, the title tooltip
     carries the full sentence.

     While the turn streams through this run the row stays expanded so live
     progress is visible, showing the live summary instead (current action +
     cumulative per-kind stats + ticking whole seconds, the thinking row's
     vocabulary); once every item settles it folds itself back — even if the
     user expanded it mid-run (the thinking block's vocabulary),
     and a settled → running transition (the stream appending to the same
     run) reopens it. The expanded body is the items flat, in order: thinking
     rows and tool rows, each with its own in-row details intact.

     TODO(P2): hover preview — folded and idle, lingering ~400ms floats a
     mini list of the latest 4 items (prototype v1-log-card.html ?peek). -->
<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue';
import { Icon } from '@moonshot-ai/app-ui';
import ThinkingBlock from './ThinkingBlock.vue';
import ToolCall from './ToolCall.vue';
import { formatDuration, toolStackKey } from '../chatTurnRendering';
import type { ActivityItem } from '../chatTurnRendering';
import type { FilePreviewRequest, ToolMedia } from '../../types';
import { summarizeActivity, summarizeLive } from '../../lib/activitySummary';
import type { SummaryClause, SummaryTone } from '../../lib/activitySummary';
import { toolIconName } from '../../lib/toolMeta';

const props = withDefaults(
  defineProps<{
    items: ActivityItem[];
    mobile?: boolean;
    /** True while this run is the live tail of the streaming turn (more items
        may append). Keeps the row expanded and the summary in live shape even
        across the brief gap between two tool calls. */
    streaming?: boolean;
  }>(),
  { mobile: false, streaming: false },
);

const emit = defineEmits<{
  openMedia: [media: ToolMedia];
  openFile: [target: FilePreviewRequest];
  openAgent: [toolCallId: string];
}>();

const lastItem = computed(() => props.items.at(-1));

/** The item the run is currently working on: the streaming thinking tail, or
    the last still-running tool. Null in the gap between two steps. */
const currentItem = computed<ActivityItem | null>(() => {
  const last = lastItem.value;
  if (props.streaming && last?.kind === 'thinking') return last;
  for (let i = props.items.length - 1; i >= 0; i--) {
    const item = props.items[i];
    if (item?.kind === 'tool' && item.tool.status === 'running') return item;
  }
  return null;
});

const runStatus = computed<'running' | 'error' | 'done'>(() => {
  if (props.streaming) return 'running';
  for (const item of props.items) {
    if (item.kind === 'tool' && item.tool.status === 'running') return 'running';
  }
  for (const item of props.items) {
    if (item.kind === 'tool' && item.tool.status === 'error') return 'error';
  }
  return 'done';
});

// The default applies only at mount; manual toggles stick.
const open = ref(runStatus.value === 'running');

const pinScroll = inject<(el: HTMLElement, ms?: number) => void>('pinScroll', () => {});
const headEl = ref<HTMLElement | null>(null);

// Renderer-measured run span (live sessions only): the clock opens when the
// run first reads running and freezes into the summary's trailing duration
// when it settles. History turns carry no measurement — their summary simply
// omits the span.
const startedMs = ref<number | null>(null);
const settledDurationMs = ref<number | undefined>(undefined);
const nowMs = ref(Date.now());

/** Earliest chain-known start of the run: a thinking item's streaming-open
    stamp (renderer-measured, live only). The clock seeds from it so the run's
    span covers the first step too — the run only mounts once a SECOND
    foldable item arrives, so starting at mount would drop everything the
    first step took. Tool-first runs carry no such stamp and fall back to
    mount time (an underestimate we can't recover without chain timestamps). */
const seededStartMs = computed<number | null>(() => {
  let best: number | null = null;
  for (const item of props.items) {
    if (item.kind === 'thinking' && item.startedAt !== undefined) {
      const ms = Date.parse(item.startedAt);
      if (Number.isFinite(ms) && (best === null || ms < best)) best = ms;
    }
  }
  return best;
});

// Settle quiet: once every item in the run has finished (the stream moved
// past it), fold back to the summary row — even if the user expanded it
// mid-run (the thinking block's vocabulary). This auto-fold is not a user
// toggle, so it carries no scroll pin. A settled → running transition (the
// stream appending another step to this same run) reopens the row.
watch(
  runStatus,
  (status, prev, onCleanup) => {
    if (status === 'running') {
      if (prev !== undefined && prev !== 'running') open.value = true;
      if (startedMs.value === null) startedMs.value = seededStartMs.value ?? Date.now();
      settledDurationMs.value = undefined;
      nowMs.value = Date.now();
      const timer = setInterval(() => {
        nowMs.value = Date.now();
      }, 1000);
      onCleanup(() => clearInterval(timer));
      return;
    }
    if (prev === 'running') {
      open.value = false;
      if (startedMs.value !== null) settledDurationMs.value = Date.now() - startedMs.value;
      startedMs.value = null;
    }
  },
  { immediate: true },
);

function toggle(): void {
  open.value = !open.value;
  // A streaming run keeps growing on its own — no pin: the follow (or native
  // anchoring off-follow) absorbs the toggle (same rule as ThinkingBlock).
  if (props.streaming) return;
  const el = headEl.value;
  if (el) nextTick(() => pinScroll(el));
}

// While running the glyph is the current step's own icon (falling back to the
// latest step in the gap between two steps); settled it carries the outcome.
const glyphIcon = computed(() => {
  if (runStatus.value === 'done') return 'check';
  if (runStatus.value === 'error') return 'close';
  const item = currentItem.value ?? lastItem.value;
  if (!item) return 'tool';
  return item.kind === 'thinking' ? 'thinking' : toolIconName(item.tool.name);
});

const live = computed(() => summarizeLive(props.items, currentItem.value));
const settled = computed(() => summarizeActivity(props.items, { durationMs: settledDurationMs.value }));

const elapsedLabel = computed(() => {
  if (runStatus.value !== 'running' || startedMs.value === null) return '';
  return formatDuration(nowMs.value - startedMs.value);
});

const displayClauses = computed<SummaryClause[]>(() => {
  if (runStatus.value !== 'running') return settled.value.clauses;
  const clauses: SummaryClause[] = [];
  if (live.value.current) clauses.push(live.value.current);
  clauses.push(...live.value.done);
  if (elapsedLabel.value) clauses.push({ fragments: [{ text: elapsedLabel.value, tone: 'faint' }] });
  return clauses;
});

const plainTitle = computed(() => {
  if (runStatus.value !== 'running') return settled.value.plain;
  return [live.value.plain, elapsedLabel.value].filter(Boolean).join(' · ');
});

function fragClass(tone: SummaryTone): string | undefined {
  if (tone === 'danger') return 'ar-danger';
  if (tone === 'faint') return 'ar-faint';
  return undefined;
}

function itemKey(item: ActivityItem): string {
  return item.kind === 'tool' ? toolStackKey(item) : `thinking-${item.sourceIndex}`;
}

/** A thinking item streams only while it is the run's (and thus the turn's)
    live tail — the thinking block folds itself back once the stream moves on.
    A settled durationMs means the turn parked on an approval/question. */
function isThinkingStreaming(item: ActivityItem): boolean {
  return (
    props.streaming &&
    item.kind === 'thinking' &&
    item.durationMs === undefined &&
    item.sourceIndex === lastItem.value?.sourceIndex
  );
}
</script>

<template>
  <div class="activity-run" :class="{ open }">
    <button ref="headEl" class="ar-head" type="button" :aria-expanded="open" @click="toggle">
      <span
        class="ar-glyph"
        :class="{ run: runStatus === 'running', err: runStatus === 'error', ok: runStatus === 'done' }"
        role="status"
        :aria-label="runStatus"
      >
        <Icon :name="glyphIcon" size="sm" aria-hidden="true" />
      </span>
      <span class="ar-sum" :title="plainTitle">
        <template v-for="(clause, ci) in displayClauses" :key="ci">
          <span v-if="ci > 0" class="ar-sep"> · </span><span
            v-for="(frag, fi) in clause.fragments"
            :key="fi"
            :class="fragClass(frag.tone)"
            >{{ frag.text }}</span
          >
        </template>
      </span>
      <Icon class="ar-car" name="chevron-right" size="sm" aria-hidden="true" />
    </button>
    <div class="ar-body" :class="{ open }" :inert="!open">
      <div class="ar-body-inner">
        <template v-for="item in items" :key="itemKey(item)">
          <ThinkingBlock
            v-if="item.kind === 'thinking'"
            :text="item.thinking"
            :mobile="mobile"
            :streaming="isThinkingStreaming(item)"
            :started-at="item.startedAt"
            :duration-ms="item.durationMs"
          />
          <ToolCall
            v-else
            :tool="item.tool"
            :mobile="mobile"
            @open-media="emit('openMedia', $event)"
            @open-file="emit('openFile', $event)"
            @open-agent="emit('openAgent', $event)"
          />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.activity-run {
  display: flex;
  flex-direction: column;
  animation: kimi-card-in var(--duration-base) var(--ease-out);
}

/* Head row — the thinking row's / group caption's language: borderless faint
   text row (text-colour hover only, no wash), one whole-row button, chevron
   rotating 90°. It rides a slightly roomier 8px vertical padding than the
   quiet lines it summarises (30px vs 22px) — the turn-level row wants the
   presence; anything tighter read cramped between prose paragraphs. */
.ar-head {
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
     text em box and the glyph centre exactly. */
  line-height: 1;
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition: color var(--duration-base) var(--ease-out);
}
.ar-head:hover {
  color: var(--color-text);
}
.ar-head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--color-accent-soft);
}

.ar-glyph {
  display: inline-flex;
  align-items: center;
  flex: none;
  color: var(--color-text-faint);
}
.ar-glyph.ok {
  color: var(--color-success);
}
.ar-glyph.err {
  color: var(--color-danger);
}
/* While the run is live the glyph breathes (opacity only, the group caption's
   vocabulary — the design system bans gradient shimmer); reduced-motion keeps
   it static. */
.ar-glyph.run {
  color: var(--color-text-muted);
  animation: ar-breathe 1.6s var(--ease-in-out) infinite;
}
@keyframes ar-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ar-glyph.run {
    animation: none;
  }
}

/* The summary sentence rides at the row's faint rung and truncates to one
   line with an ellipsis; the title tooltip carries the full text. Failure
   clauses drop to danger, thinking / duration one rung fainter. */
.ar-sum {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--weight-regular);
}
.ar-danger {
  color: var(--color-danger);
}
.ar-faint {
  color: var(--color-text-faint);
}
.ar-sep {
  color: var(--color-text-faint);
}
.ar-car {
  /* Disclosure chevron hugs the summary text (thinking-row style), always
     visible. */
  color: var(--color-text-faint);
  flex: none;
  transition: transform var(--duration-base) var(--ease-out);
}
.activity-run.open .ar-car {
  transform: rotate(90deg);
}

/* Expanded items: grid-rows animation; the quiet lines keep their own 4px
   row rhythm but breathe 8px apart (flush-stacked mixed kinds read as one
   dense block otherwise) with a small inset below the head. No dividers, no
   internal scroll window. */
.ar-body {
  display: grid;
  grid-template-rows: minmax(0, 0fr);
  overflow: hidden;
  transition: grid-template-rows var(--duration-base) var(--ease-out);
}
.ar-body.open {
  grid-template-rows: minmax(0, 1fr);
}
.ar-body-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-1);
}
</style>
