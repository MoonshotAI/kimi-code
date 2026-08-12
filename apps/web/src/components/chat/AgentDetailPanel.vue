<script setup lang="ts">
import { computed, inject, onBeforeUnmount, provide, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, Icon, IconButton, PanelHeader, Tooltip } from '@moonshot-ai/app-ui';

import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { useFollowScroll } from '@moonshot-ai/app-client/composables';
import type { AgentMember, ChatTurn, FilePreviewRequest, OpenMediaRequest } from '../../types';
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
  openMedia: [payload: OpenMediaRequest];
  openTurnDiff: [change: TurnFileChange];
}>();
const { t } = useI18n();

// Bash details carry their verbatim command on member.prompt and the terminal
// output on outputLines — both stay one click away, as the old inline detail
// had it.
const copied = ref<'command' | 'output' | null>(null);
// The clipboard's "output": the detail body's real output blocks — answer
// text, tool lines, result — but NOT the prompt or its `$ <command>`
// placeholder preview: a bash task's command has its own copy button next
// door, so the clipboard must not mix command into output. Also gates the
// button: a placeholder-only preview is not output.
const copyableOutput = computed(() => {
  const command = props.member.prompt?.trim();
  const placeholder = command ? `$ ${command}` : null;
  return fallbackOutput.value.filter((block) => block !== command && block !== placeholder).join('\n');
});
// A second successful copy (the other button, or a fast re-click) retires the
// previous hide timer — otherwise the older timeout still fires and clears
// the newer check early.
let copyTimer: ReturnType<typeof setTimeout> | null = null;
// Bumped on task switch, so a late clipboard resolve from the previous task
// never lands its copied check on the new one.
let copySerial = 0;
function copyMember(what: 'command' | 'output'): void {
  const text = what === 'command' ? props.member.prompt : copyableOutput.value;
  if (!text) return;
  const serial = copySerial;
  void copyTextToClipboard(text).then((ok) => {
    if (!ok || serial !== copySerial) return;
    if (copyTimer !== null) clearTimeout(copyTimer);
    copied.value = what;
    copyTimer = setTimeout(() => {
      copyTimer = null;
      copied.value = null;
    }, 1400);
  });
}

const identity = computed(() => props.member.id);
const { scroller, following, onScroll, pinScroll } = useFollowScroll(identity);

// A task switch retires the previous task's copied check and its hide timer.
watch(identity, () => {
  copySerial++;
  if (copyTimer !== null) clearTimeout(copyTimer);
  copyTimer = null;
  copied.value = null;
});

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
  // A `$ <command>` placeholder preview is not output — the verbatim command
  // already leads this list, so the placeholder form is skipped entirely.
  const command = props.member.prompt?.trim();
  const placeholder = command ? `$ ${command}` : null;
  for (const value of [
    // The task's own brief first — a bash task's verbatim command rides this
    // field, and without it the fallback loses the command entirely.
    props.member.prompt,
    props.member.suspendedReason,
    props.member.text,
    props.member.outputLines?.join('\n'),
    props.member.summary,
  ]) {
    const block = value?.trim();
    if (!block || seen.has(block)) continue;
    if (placeholder !== null && block === placeholder) continue;
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
    case 'cancelled': return t('tools.swarm.phaseCancelled');
  }
}

// Subtitle: agent type · bound model (friendly name) · effort (concrete levels only).
const modelDisplay = inject<(alias: string | undefined) => string | undefined>('modelDisplay');
const subagentEffort = inject<(effort: string | undefined) => string | undefined>('subagentEffort');
const subtitle = computed(() => {
  const parts = [
    props.member.subagentType,
    modelDisplay?.(props.member.model),
    subagentEffort?.(props.member.thinkingEffort),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : undefined;
});
</script>

<template>
  <div class="agent-panel">
    <PanelHeader
      :title="member.name"
      :subtitle="subtitle"
      :close-label="t('thinking.close')"
      @close="emit('close')"
    >
      <Badge variant="neutral" size="sm">{{ phaseLabel(member.phase) }}</Badge>
      <Tooltip v-if="member.prompt" :text="t('tasks.copyCommand')">
        <IconButton size="sm" :label="t('tasks.copyCommand')" @click="copyMember('command')">
          <Icon :name="copied === 'command' ? 'check' : 'copy'" size="sm" />
        </IconButton>
      </Tooltip>
      <Tooltip v-if="copyableOutput" :text="t('tasks.copyOutput')">
        <IconButton size="sm" :label="t('tasks.copyOutput')" @click="copyMember('output')">
          <Icon :name="copied === 'output' ? 'check' : 'copy'" size="sm" />
        </IconButton>
      </Tooltip>
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
