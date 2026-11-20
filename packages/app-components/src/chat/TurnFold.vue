<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { HistoryStateKey } from '@moonshot-ai/app-core/contracts';
import BlockList from './BlockList.vue';
import { PinScrollKey } from '@moonshot-ai/app-client/contracts';
import { Markdown } from '@moonshot-ai/app-markdown';
import ThinkingBlock from './ThinkingBlock.vue';
import RequestDebugRow from './RequestDebugRow.vue';
import ActivityRun from './ActivityRun.vue';
import ToolCall from './ToolCall.vue';
import NotificationCard from './NotificationCard.vue';
import { formatDuration, renderBlockKey, turnWorkMs } from '@moonshot-ai/app-components';
import type { AssistantRenderBlock } from '@moonshot-ai/app-components';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import type { OpenMediaRequest } from '@moonshot-ai/app-core/client/types';

const props = withDefaults(
  defineProps<{
    items: AssistantRenderBlock[];
    mobile?: boolean;
    streamingTailIndex?: number | null;
    activityRunTailIndex?: number | null;
    live?: boolean;
    parked?: boolean;
    seedMs?: number;
    createdMs?: number;
    endedMs?: number;
    durationMs?: number;
    resolveFilePath?: (path: string) => { path: string; assumed: boolean } | null;
    resolveImage?: (src: string) => Promise<string>;
  }>(),
  {
    mobile: false,
    streamingTailIndex: null,
    activityRunTailIndex: null,
    live: false,
    parked: false,
    seedMs: undefined,
    createdMs: undefined,
    endedMs: undefined,
    durationMs: undefined,
    resolveFilePath: undefined,
    resolveImage: undefined,
  },
);

const emit = defineEmits<{
  openMedia: [payload: OpenMediaRequest];
  detach: [toolCallId: string];
}>();

const panelApi = inject(panelApiKey);

const { t } = useI18n();

const streaming = computed(() => props.live && !props.parked);
const visibleItems = computed(() => props.items.filter(block => block.kind !== 'text' || block.text));

const phase = computed<'live' | 'parked' | 'settled'>(() => {
  if (!props.live) return 'settled';
  return props.parked ? 'parked' : 'live';
});

const historyState = inject(HistoryStateKey, undefined);
const openKey = 'turn-fold';
const open = ref((historyState?.get(openKey) as boolean | undefined) ?? (false));
watch(open, value => historyState?.set(openKey, value), { flush: 'sync' });
const effectiveOpen = computed(() => streaming.value || open.value);

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
        bodyOpen.value = true;
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
    if (prev === 'live' && now !== 'live') {
      open.value = false;
    }
  },
  { immediate: true },
);

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

function isBlockStreaming(block: { sourceIndex: number }): boolean {
  return block.sourceIndex === props.streamingTailIndex;
}

function isRunStreaming(block: { items: { sourceIndex: number }[] }): boolean {
  const last = block.items.at(-1);
  return last !== undefined && last.sourceIndex === props.streamingTailIndex;
}

function isRunLive(block: { items: { sourceIndex: number }[] }): boolean {
  const last = block.items.at(-1);
  return last !== undefined && last.sourceIndex === props.activityRunTailIndex;
}
</script>

<template>
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
        <BlockList :items="visibleItems" :item-key="renderBlockKey" :enabled="!!historyState" scope="turn-fold"><template #default="{ item: blk }">
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
              :open-file="panelApi?.openFile"
              :resolve-file-path="props.resolveFilePath"
              :resolve-image="props.resolveImage"
            />
          </div>
          <ActivityRun
            v-else-if="blk.kind === 'activity-run'"
            :items="blk.items"
            :mobile="mobile"
            :live="isRunLive(blk)"
            :streaming="isRunStreaming(blk)"
            :resolve-file-path="props.resolveFilePath"
            :resolve-image="props.resolveImage"
            @open-media="emit('openMedia', $event)"
            @detach="emit('detach', $event)"
          />
          <ToolCall
            v-else-if="blk.kind === 'tool'"
            :tool="blk.tool"
            :mobile="mobile"
            :resolve-file-path="props.resolveFilePath"
            :resolve-image="props.resolveImage"
            @open-media="emit('openMedia', $event)"
            @detach="emit('detach', $event)"
          />
          <NotificationCard v-else-if="blk.kind === 'notification'" :items="blk.items" />
          <template v-if="blk.kind === 'thinking' || blk.kind === 'text' || blk.kind === 'tool'"><RequestDebugRow v-for="(debug, di) in blk.debug ?? []" :key="di" :debug="debug" /></template>
        </template></BlockList>
      </div>
    </div>
  </div>
</template>

<style scoped>
.turn-fold {
  display: flex;
  flex-direction: column;
}

.tf-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
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
.tf-head:hover {
  color: var(--color-text);
}
.tf-head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--color-accent-soft);
}

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
  width: 12px;
  height: 12px;
  transition: transform var(--duration-base) var(--ease-out);
}
.turn-fold.open .tf-car {
  transform: rotate(90deg);
}

.tf-body {
  display: grid;
  grid-template-rows: minmax(0, 0fr);
  overflow: hidden;
  margin-right: calc(-1 * var(--space-1-5));
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
  padding-right: var(--space-1-5);
}
.tf-body-inner > :deep(.think),
.tf-body-inner > :deep(.block-list > .history-row > .think),
.tf-body-inner > :deep(.tool-group),
.tf-body-inner > :deep(.block-list > .history-row > .tool-group),
.tf-body-inner > :deep(.activity-run),
.tf-body-inner > :deep(.block-list > .history-row > .activity-run),
.tf-body-inner > :deep(.agent-group),
.tf-body-inner > :deep(.block-list > .history-row > .agent-group),
.tf-body-inner > :deep(.tool-line),
.tf-body-inner > :deep(.block-list > .history-row > .tool-line),
.tf-body-inner > :deep(.media-tool),
.tf-body-inner > :deep(.block-list > .history-row > .media-tool),
.tf-body-inner > :deep(.ask-receipt),
.tf-body-inner > :deep(.block-list > .history-row > .ask-receipt) {
  margin-top: var(--chat-block-gap);
}
.tf-body-inner > :deep(.think),
.tf-body-inner > :deep(.block-list > .history-row > .think),
.tf-body-inner > :deep(.turn-fold),
.tf-body-inner > :deep(.block-list > .history-row > .turn-fold),
.tf-body-inner > :deep(.activity-run),
.tf-body-inner > :deep(.block-list > .history-row > .activity-run) {
  margin-top: var(--chat-strip-gap);
}
.tf-body-inner > :deep(.tool-line),
.tf-body-inner > :deep(.block-list > .history-row > .tool-line),
.tf-body-inner > :deep(.ntf-list),
.tf-body-inner > :deep(.block-list > .history-row > .ntf-list) {
  margin-top: var(--chat-group-gap);
}
.tf-body-inner > .msg + :deep(.tool-line),
.tf-body-inner > :deep(.block-list > .history-row:has(> .msg) + .history-row > .tool-line),
.tf-body-inner > .msg + :deep(.ntf-list),
.tf-body-inner > :deep(.block-list > .history-row:has(> .msg) + .history-row > .ntf-list) {
  margin-top: var(--chat-strip-gap);
}
.tf-body-inner > :deep(.tool-line + .tool-line),
.tf-body-inner > :deep(.block-list > .history-row:has(> .tool-line) + .history-row > .tool-line),
.tf-body-inner > :deep(.ntf-list + .tool-line),
.tf-body-inner > :deep(.block-list > .history-row:has(> .ntf-list) + .history-row > .tool-line),
.tf-body-inner > :deep(.tool-line + .ntf-list),
.tf-body-inner > :deep(.block-list > .history-row:has(> .tool-line) + .history-row > .ntf-list) {
  margin-top: var(--chat-strip-tight);
}
.tf-body-inner > :deep(.tool-line.open + .tool-line),
.tf-body-inner > :deep(.block-list > .history-row:has(> .tool-line.open) + .history-row > .tool-line),
.tf-body-inner > :deep(.ntf-list:has(.tool-line.open) + .tool-line),
.tf-body-inner > :deep(.block-list > .history-row:has(> .ntf-list .tool-line.open) + .history-row > .tool-line),
.tf-body-inner > :deep(.tool-line.open + .ntf-list),
.tf-body-inner > :deep(.block-list > .history-row:has(> .tool-line.open) + .history-row > .ntf-list) {
  margin-top: var(--chat-group-gap);
}
.tf-body-inner > :deep(.tool-line + .think),
.tf-body-inner > :deep(.tool-line + .activity-run),
.tf-body-inner > :deep(.ntf-list + .think),
.tf-body-inner > :deep(.ntf-list + .activity-run),
.tf-body-inner > :deep(.block-list > .history-row:has(> .tool-line) + .history-row > .think),
.tf-body-inner > :deep(.block-list > .history-row:has(> .tool-line) + .history-row > .activity-run),
.tf-body-inner > :deep(.block-list > .history-row:has(> .ntf-list) + .history-row > .think),
.tf-body-inner > :deep(.block-list > .history-row:has(> .ntf-list) + .history-row > .activity-run) {
  margin-top: var(--chat-strip-tight);
}
.tf-body-inner > :deep(.tool-line.open + .think),
.tf-body-inner > :deep(.tool-line.open + .activity-run),
.tf-body-inner > :deep(.ntf-list:has(.tool-line.open) + .think),
.tf-body-inner > :deep(.ntf-list:has(.tool-line.open) + .activity-run),
.tf-body-inner > :deep(.block-list > .history-row:has(> .tool-line.open) + .history-row > .think),
.tf-body-inner > :deep(.block-list > .history-row:has(> .tool-line.open) + .history-row > .activity-run),
.tf-body-inner > :deep(.block-list > .history-row:has(> .ntf-list .tool-line.open) + .history-row > .think),
.tf-body-inner > :deep(.block-list > .history-row:has(> .ntf-list .tool-line.open) + .history-row > .activity-run) {
  margin-top: var(--chat-group-gap);
}

.turn-fold.streaming .tf-body-inner > .msg:first-child,
.turn-fold.streaming .tf-body-inner > :deep(.think:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.tool-group:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.activity-run:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.agent-group:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.tool-line:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.ntf-list:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.media-tool:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.ask-receipt:first-child),
.turn-fold.streaming .tf-body-inner > :deep(.block-list > .history-row:first-child > .msg),
.turn-fold.streaming .tf-body-inner > :deep(.block-list > .history-row:first-child > .think),
.turn-fold.streaming .tf-body-inner > :deep(.block-list > .history-row:first-child > .tool-group),
.turn-fold.streaming .tf-body-inner > :deep(.block-list > .history-row:first-child > .activity-run),
.turn-fold.streaming .tf-body-inner > :deep(.block-list > .history-row:first-child > .agent-group),
.turn-fold.streaming .tf-body-inner > :deep(.block-list > .history-row:first-child > .tool-line),
.turn-fold.streaming .tf-body-inner > :deep(.block-list > .history-row:first-child > .ntf-list),
.turn-fold.streaming .tf-body-inner > :deep(.block-list > .history-row:first-child > .media-tool),
.turn-fold.streaming .tf-body-inner > :deep(.block-list > .history-row:first-child > .ask-receipt) {
  margin-top: 0;
}

.tf-body-inner .msg {
  font-size: var(--ui-font-size);
  line-height: var(--leading-prose);
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
.tf-body-inner .msg :deep(p) { margin: 0; }
.tf-body-inner .msg :deep(p + p) { margin-top: var(--space-2); }

@container (min-width: 760px) {
  .tf-body.open:has(.md-table-wide),
  .tf-body-inner:has(.md-table-wide) {
    overflow: visible;
  }
  .tf-body-inner .msg :deep(.markstream-vue.markdown-renderer:has(.md-table-actions)) {
    content-visibility: visible;
  }
  .tf-body-inner .msg :deep(.md-table-scroll-host) {
    margin-right: calc(var(--markdown-code-action-size) + var(--markdown-code-action-gap));
  }
  .tf-body-inner .msg :deep(.table-node-wrapper.md-table-wide) {
    --md-table-wide-full: calc(
      100cqi - var(--space-5) - var(--space-5) - var(--markdown-code-action-size) - var(--markdown-code-action-gap)
    );
    --md-table-wide-width: min(var(--md-table-wide-full), var(--p-table-wide-max));
    width: var(--md-table-wide-width);
    min-width: min(100%, var(--md-table-wide-width));
    max-width: var(--md-table-wide-width) !important;
    margin-left: calc(0.5 * min((var(--markdown-code-action-size) + var(--markdown-code-action-gap)), var(--md-table-wide-full) - var(--md-table-wide-width)));
  }
  .tf-body-inner .msg :deep(.table-node-wrapper:not(.md-table-wide)) {
    --table-cell-cap: min(var(--p-table-cell-max), 36cqi);
  }
}

</style>
