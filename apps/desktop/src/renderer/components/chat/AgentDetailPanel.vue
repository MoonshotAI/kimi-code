<!-- apps/web/src/components/chat/AgentDetailPanel.vue -->
<script setup lang="ts">
import { computed, onBeforeUnmount, provide, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, PanelHeader } from '@moonshot-ai/web-ui';

import { useFollowScroll } from '../../composables/useFollowScroll';
import type { AgentMember, ChatTurn, FilePreviewRequest, ToolMedia } from '../../types';
import type { TurnFileChange } from '../chatTurnRendering';
import ChatPane from './ChatPane.vue';
import OutputPanel from './tool-calls/OutputPanel.vue';

const props = defineProps<{
  member: AgentMember;
  turns: ChatTurn[];
  running: boolean;
  loading: boolean;
  loadError: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: boolean;
}>();

const emit = defineEmits<{
  close: [];
  loadOlderMessages: [];
  openAgent: [agentId: string];
  openFile: [target: FilePreviewRequest];
  openMedia: [media: ToolMedia];
  openTurnDiff: [change: TurnFileChange];
}>();

const { t } = useI18n();
const identity = computed(() => props.member.id);
const { scroller, following, onScroll, pinScroll } = useFollowScroll(identity);

// Mounting the transcript (with its Markdown renders) while the panel's width
// change has not been laid out yet makes mount-time width measurements force
// a whole-page layout. rAF callbacks run before the frame's layout, so wait
// two frames — one full rendering opportunity — before mounting content.
const contentReady = ref(false);
let readyFrame: number | null = null;
let readyTimer: ReturnType<typeof setTimeout> | null = null;

function cancelReadySchedule(): void {
  if (readyFrame !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(readyFrame);
  }
  if (readyTimer !== null) clearTimeout(readyTimer);
  readyFrame = null;
  readyTimer = null;
}

watch(identity, () => {
  contentReady.value = false;
  cancelReadySchedule();
  const done = (): void => {
    cancelReadySchedule();
    contentReady.value = true;
  };
  if (typeof requestAnimationFrame === 'function') {
    readyFrame = requestAnimationFrame(() => {
      readyFrame = requestAnimationFrame(done);
    });
  } else {
    readyTimer = setTimeout(done, 32);
  }
}, { immediate: true });
onBeforeUnmount(cancelReadySchedule);
const fallbackOutput = computed(() => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of [
    props.member.suspendedReason,
    props.member.text,
    props.member.outputLines?.join('\n'),
    props.member.summary,
  ]) {
    const block = value?.trim();
    if (!block || seen.has(block)) continue;
    seen.add(block);
    output.push(block);
  }
  return output;
});

provide('pinScroll', () => {
  if (scroller.value) pinScroll();
});

function phaseLabel(phase: AgentMember['phase']): string {
  switch (phase) {
    case 'queued': return t('tools.swarm.phaseQueued');
    case 'working': return t('tools.swarm.phaseWorking');
    case 'suspended': return t('tools.swarm.phaseSuspended');
    case 'completed': return t('tools.swarm.phaseCompleted');
    case 'failed': return t('tools.swarm.phaseFailed');
  }
}
</script>

<template>
  <div class="agent-panel">
    <PanelHeader
      :title="member.name"
      :subtitle="member.subagentType"
      :close-label="t('thinking.close')"
      @close="emit('close')"
    >
      <Badge variant="neutral" size="sm">{{ phaseLabel(member.phase) }}</Badge>
    </PanelHeader>
    <div ref="scroller" class="agent-transcript" @scroll.passive="onScroll">
      <template v-if="contentReady">
        <div
          v-if="turns.length === 0 && !loading && (loadError || fallbackOutput.length > 0)"
          class="agent-fallback"
        >
          <div v-if="loadError" class="agent-error">{{ t('tasks.transcriptLoadError') }}</div>
          <OutputPanel v-if="fallbackOutput.length > 0" :lines="fallbackOutput" />
        </div>
        <ChatPane
          v-else
          :turns="turns"
          :turn-active="running"
          :session-loading="loading && turns.length === 0"
          :has-more-messages="hasMore"
          :loading-more="loadingMore"
          :loading-more-error="loadMoreError"
          :is-following="following"
          read-only
          @load-older-messages="emit('loadOlderMessages')"
          @open-agent="emit('openAgent', $event)"
          @open-file="emit('openFile', $event)"
          @open-media="emit('openMedia', $event)"
          @open-turn-diff="emit('openTurnDiff', $event)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.agent-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}

.agent-transcript {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.agent-transcript :deep(.think-body),
.agent-transcript :deep(.ar-body),
.agent-transcript :deep(.tf-body),
.agent-transcript :deep(.bb),
.agent-transcript :deep(.tl-body) {
  transition: none;
}

.agent-error {
  color: var(--color-danger);
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
}

.agent-fallback {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
}
</style>
