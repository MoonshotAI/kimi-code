<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue';
import { Icon, Tooltip } from '@moonshot-ai/app-ui';
import { HistoryStateKey } from '@moonshot-ai/app-core/contracts';
import BlockList from './BlockList.vue';
import { useHistoryState } from './historyState';
import { PinScrollKey } from '@moonshot-ai/app-client/contracts';
import { useActivityRunFolding, useAutoReviewHint } from '@moonshot-ai/app-client/composables';
import ThinkingBlock from './ThinkingBlock.vue';
import ToolCall from './ToolCall.vue';
import RequestDebugRow from './RequestDebugRow.vue';
import BrowserReceiptStrip from './tool-calls/browser/BrowserReceiptStrip.vue';
import BrowserLiveEntry from './tool-calls/browser/BrowserLiveEntry.vue';
import BrowserRetryRun from './tool-calls/browser/BrowserRetryRun.vue';
import { BrowserToolContextKey } from './tool-calls/browserToolContext';
import { browserToolFailed } from './tool-calls/browserToolPresentation';
import { foldBrowserRetries, type ActivityRunItem } from './tool-calls/browserRetries';
import { formatDuration } from '@moonshot-ai/app-core/lib';
import { toolStackKey, type ActivityItem } from '../chatTurnRendering';
import type { OpenMediaRequest } from '@moonshot-ai/app-core/client/types';
import { summarizeActivity, summarizeLive, type SummaryClause, type SummaryTone } from '../lib/activitySummary';
import type { ToolCall as ToolCallData } from '@moonshot-ai/app-core/client/types';

const props = withDefaults(
  defineProps<{
    items: ActivityItem[];
    mobile?: boolean;
    live?: boolean;
    streaming?: boolean;
    forceOpen?: boolean;
    resolveFilePath?: (path: string) => { path: string; assumed: boolean } | null;
    resolveImage?: (src: string) => Promise<string>;
  }>(),
  { mobile: false, live: false, streaming: false, forceOpen: false, resolveFilePath: undefined, resolveImage: undefined },
);

const emit = defineEmits<{
  openMedia: [payload: OpenMediaRequest];
  detach: [toolCallId: string];
}>();

const lastItem = computed(() => props.items.at(-1));

const currentItem = computed<ActivityItem | null>(() => {
  const last = lastItem.value;
  if (props.streaming && last?.kind === 'thinking') return last;
  for (let i = props.items.length - 1; i >= 0; i--) {
    const item = props.items[i];
    if (item?.kind === 'tool' && item.tool.status === 'running') return item;
  }
  return null;
});

const browserContexts = inject(BrowserToolContextKey, undefined);
const contextOf = (tool: ToolCallData) => browserContexts?.value.get(tool);
const folded = computed(() => foldBrowserRetries(props.items, contextOf));

const runStatus = computed<'running' | 'error' | 'done'>(() => {
  if (props.live || props.streaming) return 'running';
  for (const item of props.items) {
    if (item.kind === 'tool' && item.tool.status === 'running') return 'running';
  }
  for (const item of props.items) {
    if (item.kind === 'tool' && browserToolFailed(item.tool) && !folded.value.recovered.has(item.tool)) return 'error';
  }
  return 'done';
});

const historyState = inject(HistoryStateKey, undefined);
const openKey = `activity:${props.items[0] ? itemKey(props.items[0]) : ''}`;
const open = ref((historyState?.get(openKey) as boolean | undefined) ?? (runStatus.value === 'running'));
watch(open, value => historyState?.set(openKey, value), { flush: 'sync' });
const { activityRunFolding } = useActivityRunFolding();
const effectiveOpen = computed(() => props.forceOpen || !activityRunFolding.value || open.value);

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
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (effectiveOpen.value) bodyOpen.value = true;
      });
    });
    return;
  }
  bodyOpen.value = false;
  unmountTimer = setTimeout(() => {
    unmountTimer = null;
    bodyMounted.value = false;
  }, 200);
});

const pinScroll = inject(PinScrollKey, () => {});
const headEl = ref<HTMLElement | null>(null);

const startedMs = ref<number | null>(null);
const settledDurationMs = useHistoryState<number | undefined>(`${openKey}:duration`, undefined);
const nowMs = ref(Date.now());

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

watch(activityRunFolding, () => {
  open.value = runStatus.value === 'running';
});

function toggle(): void {
  if (props.forceOpen) return;
  open.value = !open.value;
  if (props.streaming) return;
  const el = headEl.value;
  if (el) nextTick(() => pinScroll(el));
}

const browserSummary = computed(() => ({ contextOf, recovered: folded.value.recovered }));

const reviewHint = useAutoReviewHint(() => {
  const item = currentItem.value;
  return item?.kind === 'tool' && item.tool.autoReviewing === true;
});
const live = computed(() => summarizeLive(props.items, currentItem.value, browserSummary.value, reviewHint.value));
const settled = computed(() => summarizeActivity(props.items, { durationMs: settledDurationMs.value, browser: browserSummary.value }));

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
  const summary = runStatus.value === 'running'
    ? [live.value.plain, elapsedLabel.value].filter(Boolean).join(' · ')
    : settled.value.plain;
  const detail = runStatus.value === 'running' ? live.value.detail : settled.value.detail;
  return [summary, detail].filter(Boolean).join(' · ');
});

const showHead = computed(() => props.forceOpen || activityRunFolding.value);
const showLive = computed(() => runStatus.value === 'running' && !props.forceOpen);

function fragClass(tone: SummaryTone): string | undefined {
  if (tone === 'faint') return 'ar-faint';
  return undefined;
}

function itemKey(item: ActivityRunItem): string {
  if (item.kind === 'browser-retry') return `retry-${toolStackKey(item)}`;
  return item.kind === 'tool' ? toolStackKey(item) : `thinking-${item.sourceIndex}`;
}

function isThinkingStreaming(item: ActivityRunItem): boolean {
  return (
    props.streaming &&
    item.kind === 'thinking' &&
    item.durationMs === undefined &&
    item.sourceIndex === lastItem.value?.sourceIndex
  );
}
</script>

<template>
  <div class="activity-run" :class="{ open: effectiveOpen }">
    <div v-if="showHead || showLive" class="ar-top">
      <Tooltip v-if="showHead" :text="plainTitle">
        <component
          :is="forceOpen ? 'div' : 'button'"
          ref="headEl"
          class="ar-head"
          :class="{ 'is-static': forceOpen }"
          v-bind="forceOpen ? {} : { type: 'button', 'aria-expanded': effectiveOpen }"
          @click="toggle"
        >
          <span class="ar-sr-only" role="status">{{ runStatus }}</span>
          <span class="ar-sum">
            <template v-for="(clause, ci) in displayClauses" :key="ci">
              <span v-if="ci > 0" class="ar-sep"> · </span><span
                v-for="(frag, fi) in clause.fragments"
                :key="fi"
                :class="fragClass(frag.tone)"
                >{{ frag.text }}</span
              >
            </template>
          </span>
          <Icon v-if="!forceOpen" class="ar-car" name="chevron-right" size="sm" aria-hidden="true" />
        </component>
      </Tooltip>
      <BrowserLiveEntry v-if="showLive" :items="items" />
    </div>
    <div v-if="!historyState || bodyMounted" class="ar-body" :class="{ open: bodyOpen }" :inert="!effectiveOpen">
      <div class="ar-body-inner">
        <BrowserReceiptStrip :items="items" @open-media="emit('openMedia', $event)" />
        <BlockList :items="folded.items" :item-key="itemKey" :enabled="!!historyState" :scope="openKey" :gap="(_, index) => index ? 4 : 0"><template #default="{ item }">
          <ThinkingBlock
            v-if="item.kind === 'thinking'"
            :text="item.thinking"
            :mobile="mobile"
            :streaming="isThinkingStreaming(item)"
            :started-at="item.startedAt"
            :duration-ms="item.durationMs"
            :instant-reveal="forceOpen"
          />
          <BrowserRetryRun
            v-else-if="item.kind === 'browser-retry'"
            :item="item"
            :mobile="mobile"
            @open-media="emit('openMedia', $event)"
            @detach="emit('detach', $event)"
          />
          <ToolCall
            v-else
            :tool="item.tool"
            :mobile="mobile"
            :resolve-file-path="props.resolveFilePath"
            :resolve-image="props.resolveImage"
            @open-media="emit('openMedia', $event)"
            @detach="emit('detach', $event)"
          />
          <template v-if="item.kind !== 'browser-retry'"><RequestDebugRow v-for="(debug, di) in item.debug ?? []" :key="di" :debug="debug" /></template>
        </template></BlockList>
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

.ar-top {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  min-width: 0;
}
.ar-head {
  display: flex;
  flex: 1;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  min-height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: 20px;
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition: color var(--duration-base) var(--ease-out);
}
.ar-head:hover {
  color: var(--color-text);
}
.ar-head.is-static,
.ar-head.is-static:hover {
  cursor: default;
  color: var(--color-text-faint);
}
.ar-head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--color-accent-soft);
}

.ar-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.ar-sum {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--weight-regular);
}
.ar-faint {
  color: var(--color-text-faint);
}
.ar-sep {
  color: var(--color-text-faint);
}
.ar-car {
  color: var(--color-text-faint);
  flex: none;
  width: 12px;
  height: 12px;
  transition: transform var(--duration-base) var(--ease-out);
}
.activity-run.open .ar-car {
  transform: rotate(90deg);
}

.ar-body {
  display: grid;
  grid-template-rows: minmax(0, 0fr);
  overflow: hidden;
  margin-right: calc(-1 * var(--space-1-5));
  transition: grid-template-rows var(--duration-base) var(--ease-out);
}
.ar-body.open {
  grid-template-rows: minmax(0, 1fr);
}
.ar-body > .ar-body-inner {
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}
.ar-body.open > .ar-body-inner {
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
  .ar-body,
  .ar-body > .ar-body-inner {
    transition: none;
  }
}
.ar-body-inner {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-top: 6px;
  padding-right: var(--space-1-5);
}
.ar-body-inner > :deep(.tool-line.open + *),
.ar-body-inner > :deep(.block-list > .history-row:has(> .tool-line.open) + .history-row > *:not(.history-navigation)) {
  margin-top: 4px;
}
</style>
