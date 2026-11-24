<script setup lang="ts">
import { useHistoryState } from '../historyState';
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { toolLabel } from '@moonshot-ai/app-components';
import {
  answerFor,
  parseAskBackground,
  parseAskInput,
  parseAskOutput,
  resolveAnswer,
} from '@moonshot-ai/app-components';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';
import AskAnswerReceipt from '../AskAnswerReceipt.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const { t, locale } = useI18n();

const SUMMARY_MAX = 80;

function clip(s: string, max = SUMMARY_MAX): string {
  const trimmed = s.trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

const questions = computed(() => parseAskInput(props.tool.arg));
const output = computed(() => parseAskOutput(props.tool.output));
const recognized = computed(() => output.value.recognized);
const isDismissed = computed(
  () => recognized.value && Object.keys(output.value.answers).length === 0 && output.value.note.length > 0,
);
const resolved = computed(() =>
  questions.value.map((q, i) => resolveAnswer(answerFor(output.value.answers, q.question, i), q.options)),
);
const answeredCount = computed(() => Object.keys(output.value.answers).length);

function isSelected(qi: number, oi: number): boolean {
  return resolved.value[qi]?.selected.has(oi) ?? false;
}
function otherText(qi: number): string {
  return resolved.value[qi]?.otherText ?? '';
}
function isIndeterminate(qi: number): boolean {
  return resolved.value[qi]?.indeterminate ?? false;
}

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const backgroundLaunch = computed(
  () => status.value !== 'error' && !recognized.value && parseAskBackground(props.tool.arg),
);

const receiptRows = computed(() =>
  questions.value.map((q, qi) => ({
    q,
    selected: q.options
      .map((o, oi) => ({ o, oi }))
      .filter(({ oi }) => isSelected(qi, oi)),
  })),
);

const flatText = computed(() => {
  const first = questions.value[0]?.question ?? '';
  const note = t('tools.ask.unanswered');
  return first ? `${first} —— ${note}` : note;
});

function answerText(qi: number): string {
  const row = receiptRows.value[qi];
  if (!row) return '';
  const parts = row.selected.map((sel) => sel.o.label);
  const other = otherText(qi);
  if (other) parts.push(other);
  if (parts.length > 0) return new Intl.ListFormat(locale.value, { type: 'conjunction' }).format(parts);
  return isIndeterminate(qi) ? t('tools.ask.answered') : t('tools.ask.unanswered');
}

const answerRows = computed(() =>
  receiptRows.value.map((row, qi) => ({
    question: row.q.question,
    answer: answerText(qi),
  })),
);

const questionSummary = computed(() => {
  const first = questions.value[0]?.question ?? '';
  const base = clip(first);
  if (questions.value.length <= 1) return base;
  return `${base}  ${t('tools.ask.more', { count: questions.value.length - 1 })}`;
});

const summary = computed(() => {
  if (!recognized.value) return backgroundLaunch.value ? questionSummary.value : clip(props.tool.output?.[0] ?? '');
  if (isDismissed.value) return t('tools.ask.dismissed');
  return questionSummary.value;
});

const chip = computed(() => {
  if (backgroundLaunch.value) return t('tools.ask.waiting');
  if (!recognized.value) return '';
  if (isDismissed.value) return t('tools.ask.dismissed');
  if (answeredCount.value === 0) return '';
  return answeredCount.value === 1
    ? t('tools.ask.answer', { count: 1 })
    : t('tools.ask.answers', { count: answeredCount.value });
});

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const canExpand = computed(() =>
  backgroundLaunch.value
    ? questions.value.length > 0 || hasOutput.value
    : (recognized.value && (questions.value.length > 0 || isDismissed.value)) || hasOutput.value,
);
const open = useHistoryState(`tool:${props.tool.id}:open`, !backgroundLaunch.value && canExpand.value);

const label = computed(() => toolLabel(props.tool.name));

watch(canExpand, (now, before) => {
  if (!backgroundLaunch.value && now && !before) open.value = true;
});
</script>

<template>
  <span v-if="recognized && status === 'ok' && (isDismissed || answeredCount === 0)" class="ask-receipt rc-flat">{{ flatText }}</span>

  <AskAnswerReceipt
    v-else-if="recognized && status === 'ok'"
    :rows="answerRows"
    :open="open"
    @toggle="open = !open"
  />

  <!-- Running / unrecognized output (background launch, error) → quiet line -->
  <ToolDisclosure v-else :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="help-circle" size="sm" /></template>
    <span class="tl-name">{{ backgroundLaunch ? t('tools.ask.background') : label }}</span>
    <span v-if="summary" class="tl-dim">{{ summary }}</span>
    <span v-if="chip" class="tl-faint">{{ chip }}</span>
    <template #body>
      <ToolPanel v-if="backgroundLaunch" scroll>
        <div class="rc-list">
          <div v-for="(q, qi) in questions" :key="qi" class="rc-q">
            <div class="rc-qtext">{{ q.question }}</div>
          </div>
        </div>
      </ToolPanel>
      <ToolPanel v-else scroll>
        <OutputPanel :lines="tool.output" />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.rc-flat {
  display: block;
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}

.rc-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rc-qtext {
  color: var(--color-text);
  font: var(--text-base)/20px var(--font-ui);
}
</style>
