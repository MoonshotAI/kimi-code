<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, provide, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, Spinner } from '@moonshot-ai/app-ui';

import { usePanelScroll } from '@moonshot-ai/app-client/composables';
import { ModelDisplayKey, PinScrollKey, SubagentEffortKey } from '@moonshot-ai/app-client/contracts';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { ComposerText } from '@moonshot-ai/app-composer/transcript';
import type { AgentMember, ChatTurn, OpenMediaRequest } from '@moonshot-ai/app-core/client/types';
import ChatPane from './ChatPane.vue';
import JumpToBottomPill from './JumpToBottomPill.vue';
import OutputPanel from './tool-calls/OutputPanel.vue';
import WorkingIndicator from './WorkingIndicator.vue';

const props = defineProps<{
  member: AgentMember;
  turns: ChatTurn[];
  running: boolean;
  loading: boolean;
  loadError: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: boolean;
  cwd?: string;
}>();
const emit = defineEmits<{
  loadOlderMessages: [];
  openMedia: [payload: OpenMediaRequest];
}>();
const { t } = useI18n();
const mediaLabels = computed(() => ({
  image: t('composer.attachmentImage'),
  video: t('composer.attachmentVideo'),
}));

const panelApi = inject(panelApiKey);
provide(
  panelApiKey,
  panelApi && {
    ...panelApi,
    openTurnDiff: ({ change }) =>
      panelApi.openTurnDiff({ turnId: `agent:${props.member.id}`, change }),
    openCompaction: undefined,
    isCompactionOpen: undefined,
  },
);

const isBash = computed(() => props.member.kind === 'bash');

const PROMPT_CLAMP_LINES = 6;

const promptText = computed(() => {
  const raw = props.member.prompt;
  return raw !== undefined && raw.trim() !== '' ? raw : undefined;
});
const promptTextEl = ref<HTMLElement | null>(null);
const promptClampable = ref(false);
const promptExpanded = ref(false);
const isPromptClamped = computed(() => promptClampable.value && !promptExpanded.value);

function measurePromptClamp(): void {
  const el = promptTextEl.value;
  if (!el) return;
  const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
  promptClampable.value = el.scrollHeight > lineHeight * PROMPT_CLAMP_LINES + 1;
}

const promptObserver =
  typeof ResizeObserver === 'undefined'
    ? null
    : new ResizeObserver(() => measurePromptClamp());
watch(promptTextEl, (el, prev) => {
  if (prev) promptObserver?.unobserve(prev);
  if (el) promptObserver?.observe(el);
  measurePromptClamp();
});
watch(promptText, () => {
  promptExpanded.value = false;
  void nextTick(measurePromptClamp);
});

function togglePrompt(event: MouseEvent): void {
  const anchor = promptExpanded.value ? event.currentTarget : promptTextEl.value;
  if (anchor instanceof HTMLElement) panelScroll.hold(anchor);
  promptExpanded.value = !promptExpanded.value;
}

const transcriptTurns = computed(() => {
  const prompt = promptText.value;
  if (prompt === undefined) return props.turns;
  const index = props.turns.findIndex((turn) => turn.role === 'user');
  if (index === -1) return props.turns;
  const first = props.turns[index]!;
  if (first.text !== prompt) return props.turns;
  const hasLegacyAttachments = (first.attachments?.length ?? 0) > 0;
  if (!hasLegacyAttachments) {
    return props.turns.filter((_, i) => i !== index);
  }
  return props.turns.map((turn, i) => (i === index ? { ...turn, text: '' } : turn));
});

const promptAttachments = computed(() => {
  const prompt = promptText.value;
  if (prompt === undefined) return undefined;
  return props.turns.find((turn) => turn.role === 'user' && turn.text === prompt)?.inlineAttachments;
});

const identity = computed(() => props.member.id);
const panelScroll = usePanelScroll({ identity: () => props.member.id });
const { scroller, following, showJump } = panelScroll;

function jumpToBottom(): void {
  panelScroll.follow();
}

const working = computed(
  () =>
    props.member.status === 'running' &&
    props.member.phase !== 'queued' &&
    props.member.phase !== 'suspended' &&
    !(props.loading && transcriptTurns.value.length === 0),
);

const fallbackWorkingLabel = computed(() =>
  t(fallbackOutput.value.length > 0 ? 'conversation.working' : 'conversation.requesting'),
);

watch(identity, () => {
  promptExpanded.value = false;
});

function onTranscriptScroll(): void {
  panelScroll.onScroll();
}

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
onBeforeUnmount(() => {
  cancelReadySchedule();
  promptObserver?.disconnect();
});
const fallbackOutput = computed(() => {
  const seen = new Set<string>();
  const output: string[] = [];
  const command = props.member.prompt?.trim();
  const placeholder = command ? `$ ${command}` : null;
  for (const value of [
    props.member.suspendedReason,
    props.member.text,
    props.member.outputLines?.join('\n'),
  ]) {
    const block = value?.trim();
    if (!block || seen.has(block)) continue;
    if (placeholder !== null && block === placeholder) continue;
    seen.add(block);
    output.push(block);
  }
  return output;
});
const fallbackProse = computed(() => props.member.kind === 'subagent');

const outputLoading = computed(() => props.member.outputLoading === true);
const showEmptyOutput = computed(
  () =>
    !outputLoading.value &&
    props.member.kind === 'tool' &&
    !working.value &&
    fallbackOutput.value.length === 0,
);
const showOutputState = computed(() => outputLoading.value || showEmptyOutput.value);

provide(PinScrollKey, (el: HTMLElement, ms?: number) => panelScroll.hold(el, ms));

const modelDisplay = inject(ModelDisplayKey);
const subagentEffort = inject(SubagentEffortKey);
const typeLabel = computed(() => {
  const type = props.member.subagentType?.trim();
  return type ? type.charAt(0).toUpperCase() + type.slice(1) : undefined;
});
const modelLabel = computed(() => {
  const parts = [
    modelDisplay?.(props.member.model),
    subagentEffort?.(props.member.thinkingEffort),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : undefined;
});
const metaLabel = computed(() => {
  const parts = [typeLabel.value, modelLabel.value].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : undefined;
});
</script>

<template>
  <div class="agent-panel">
    <div ref="scroller" class="agent-transcript" data-panel-content @scroll.passive="onTranscriptScroll">
      <div class="agent-transcript-inner">
        <div v-if="metaLabel" class="agent-meta" data-row-key="meta">
          <span class="agent-meta-text">{{ metaLabel }}</span>
        </div>
        <section v-if="promptText" class="agent-prompt" data-row-key="prompt">
          <div class="agent-prompt-bubble">
            <div class="agent-prompt-wrap" :class="{ 'is-clamped': isPromptClamped }">
              <div
                ref="promptTextEl"
                class="agent-prompt-text"
                :class="{ 'is-command': isBash }"
              ><ComposerText v-if="!isBash" :text="promptText ?? ''" :open-file="panelApi?.openFile" :attachments="promptAttachments" :media-labels="mediaLabels" /><template v-else>{{ promptText }}</template></div>
              <button
                v-if="promptClampable"
                type="button"
                class="agent-prompt-toggle"
                :aria-expanded="!isPromptClamped"
                @click="togglePrompt"
              >
                <span>{{ isPromptClamped ? t('tasks.expand') : t('tasks.collapse') }}</span>
                <Icon
                  class="agent-prompt-toggle-car"
                  :class="{ open: !isPromptClamped }"
                  name="chevron-down"
                  size="sm"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
        </section>
        <template v-if="contentReady">
          <div
            v-if="transcriptTurns.length === 0 && !loading && (loadError || fallbackOutput.length > 0 || showOutputState)"
            class="agent-fallback"
            data-row-key="fallback"
            :class="{ prose: fallbackProse }"
          >
            <div v-if="loadError" class="agent-error">{{ t('tasks.transcriptLoadError') }}</div>
            <OutputPanel v-if="fallbackOutput.length > 0" :lines="fallbackOutput" />
            <div v-else-if="showEmptyOutput" class="agent-output-state">{{ t('tools.output.empty') }}</div>
            <div v-if="outputLoading" class="agent-output-state">
              <Spinner size="sm" />
              <span>{{ t('tools.output.waiting') }}</span>
            </div>
            <WorkingIndicator v-if="working" :label="fallbackWorkingLabel" />
          </div>
          <ChatPane
            v-else
            :turns="transcriptTurns"
            :turn-active="running"
            :session-loading="loading && transcriptTurns.length === 0"
            :has-more-messages="hasMore"
            :loading-more="loadingMore"
            :loading-more-error="loadMoreError"
            :is-following="following"
            :working="working"
            :cwd="props.cwd"
            read-only
            inspector
            :selection-actions="false"
            @load-older-messages="emit('loadOlderMessages')"
            @open-media="emit('openMedia', $event)"
          />
        </template>
      </div>
    </div>
    <JumpToBottomPill :show="showJump" @click="jumpToBottom()" />
  </div>
</template>

<style scoped>
.agent-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--color-bg);
}

.agent-meta {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-3) var(--space-2);
  user-select: none;
}
.agent-meta::before,
.agent-meta::after {
  content: '';
  flex: 1;
  height: var(--p-hairline);
  background: var(--color-line);
}
.agent-meta-text {
  font-size: var(--text-xs);
  line-height: 1;
  color: var(--color-text-muted);
  white-space: nowrap;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-prompt {
  flex: none;
  display: flex;
  flex-direction: column;
  padding: 0 var(--space-3) var(--space-2);
}
.agent-prompt-bubble {
  display: flex;
  flex-direction: column;
  align-self: flex-end;
  max-width: 78%;
  padding: 10px 12px;
  background: var(--color-user-bubble-bg);
  border-radius: var(--radius-lg);
}
.agent-prompt-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
}
.agent-prompt-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: var(--content-font-size);
  line-height: var(--leading-normal);
  color: var(--color-text);
}
.agent-prompt-text.is-command {
  font-family: var(--font-mono);
}
.agent-prompt-wrap.is-clamped > .agent-prompt-text {
  max-height: calc(6 * 1lh);
  overflow: hidden;
  mask-image: linear-gradient(to bottom, black calc(100% - 2.5lh), transparent calc(100% - 0.5lh));
  -webkit-mask-image: linear-gradient(to bottom, black calc(100% - 2.5lh), transparent calc(100% - 0.5lh));
}

.agent-prompt-toggle {
  margin-top: var(--space-1);
  padding: var(--space-1) var(--space-3);
}
.agent-prompt-wrap.is-clamped .agent-prompt-toggle {
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  margin-top: 0;
}
.agent-prompt-toggle-car {
  transition: transform var(--duration-base) var(--ease-out);
}
.agent-prompt-toggle-car.open {
  transform: rotate(180deg);
}

.agent-transcript {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-bottom: var(--pfc-host-h, 0px);
}
.agent-transcript-inner {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  width: 100%;
  max-width: var(--p-content-max);
  margin-inline: auto;
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

.agent-output-state {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-faint);
  font-style: italic;
}

.agent-fallback {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
}
.agent-fallback.prose :deep(.op) {
  font-family: var(--font-ui);
}
</style>

<style scoped src="./clamp-toggle.css"></style>
