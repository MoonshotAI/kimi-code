<!-- Result rendering for the AskUserQuestion tool. On a successful answer the
     output is a single JSON line ({ answers, note? }); answers are keyed by
     question text and the values are option labels (comma-joined for
     multi-select) or free-text (Other). Legacy transcripts instead carry
     synthesized ids (`q_<index>` keys, `opt_<q>_<o>` values) — both forms are
     resolved.

     Settled + recognized → a RECEIPT CARD (the question card's "receipt"):
     a small raised card echoing only the picked options, checked with the
     same CSS glyph language as the live QuestionCard. Passed-over options
     are not echoed. Dismissed (or zero answers) collapses to a slim
     one-line card.

     Running, and error/background cases whose output is not the answer JSON
     (plain-text task id / failure reason), keep the quiet disclosure line so
     the raw output is not hidden behind an empty card. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { FilePreviewRequest, OpenMediaRequest, ToolCall } from '../../../types';
import { toolLabel } from '../../../lib/toolMeta';
import {
  answerFor,
  parseAskInput,
  parseAskOutput,
  resolveAnswer,
} from './askUserToolParse';
import ToolDisclosure from './ToolDisclosure.vue';
import OutputPanel from './OutputPanel.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

defineEmits<{
  openMedia: [payload: OpenMediaRequest];
  openFile: [target: FilePreviewRequest];
}>();

const { t } = useI18n();

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

// ---------------------------------------------------------------------------
// Receipt card (settled + recognized)
// ---------------------------------------------------------------------------

// Per-question picked rows — the card echoes only what the user chose.
const receiptRows = computed(() =>
  questions.value.map((q, qi) => ({
    q,
    selected: q.options
      .map((o, oi) => ({ o, oi }))
      .filter(({ oi }) => isSelected(qi, oi)),
  })),
);

const questionsLabel = computed(() =>
  questions.value.length === 1
    ? t('tools.ask.question', { count: 1 })
    : t('tools.ask.questions', { count: questions.value.length }),
);

// Dismissed / zero-answer flat line: question text + localized "no answer"
// (the daemon's note is a fixed English sentence — detection only, never
// shown). Without a parsed question (unparseable legacy arg) the localized
// note stands alone.
const flatText = computed(() => {
  const first = questions.value[0]?.question ?? '';
  const note = t('tools.ask.unanswered');
  return first ? `${first} —— ${note}` : note;
});

// ---------------------------------------------------------------------------
// Quiet disclosure line (running / unrecognized output)
// ---------------------------------------------------------------------------

const summary = computed(() => {
  if (!recognized.value) return clip(props.tool.output?.[0] ?? '');
  if (isDismissed.value) return t('tools.ask.dismissed');
  const first = questions.value[0]?.question ?? '';
  const base = clip(first);
  if (questions.value.length <= 1) return base;
  return `${base}  ${t('tools.ask.more', { count: questions.value.length - 1 })}`;
});

const chip = computed(() => {
  if (!recognized.value) return '';
  if (isDismissed.value) return t('tools.ask.dismissed');
  if (answeredCount.value === 0) return '';
  return answeredCount.value === 1
    ? t('tools.ask.answer', { count: 1 })
    : t('tools.ask.answers', { count: answeredCount.value });
});

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const canExpand = computed(
  () => (recognized.value && (questions.value.length > 0 || isDismissed.value)) || hasOutput.value,
);
const open = ref(props.tool.defaultExpanded === true && canExpand.value);

const label = computed(() => toolLabel(props.tool.name));

watch(
  () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);
</script>

<template>
  <!-- Settled + recognized → receipt card -->
  <div v-if="recognized && status === 'ok'" class="ask-receipt" :class="{ flat: isDismissed || answeredCount === 0 }">
    <span v-if="isDismissed || answeredCount === 0" class="rc-flat">{{ flatText }}</span>
    <template v-else>
      <div class="rc-head">
        <span>{{ t('tools.ask.collected') }} · {{ questionsLabel }}</span>
        <span class="rc-st"><Icon name="check" size="sm" /></span>
      </div>
      <div v-for="(row, qi) in receiptRows" :key="qi" class="rc-q">
        <div class="rc-qtext">
          <span>{{ row.q.question }}</span>
        </div>
        <!-- Picked options (passed-over options are not echoed) -->
        <div v-for="s in row.selected" :key="s.oi" class="rc-opt">
          <span class="rc-g on" :class="row.q.multiSelect ? 'chk' : 'rad'"></span>
          <span class="rc-lb">{{ s.o.label }}</span>
        </div>
        <div v-if="otherText(qi)" class="rc-opt">
          <span class="rc-g on" :class="row.q.multiSelect ? 'chk' : 'rad'"></span>
          <span class="rc-lb">{{ otherText(qi) }}</span>
          <span class="rc-ds">{{ t('tools.ask.freeInput') }}</span>
        </div>
        <div v-if="isIndeterminate(qi)" class="rc-opt">
          <span class="rc-g rad on"></span>
          <span class="rc-lb">{{ t('tools.ask.answered') }}</span>
        </div>
        <!-- A question with no recorded answer (legacy / foreign transcripts
             only — the live card requires every question answered) still
             records the skip, so the receipt doesn't read as a rendering
             gap. -->
        <div
          v-if="row.selected.length === 0 && !otherText(qi) && !isIndeterminate(qi)"
          class="rc-qskip"
        >{{ t('tools.ask.unanswered') }}</div>
      </div>
    </template>
  </div>

  <!-- Running / unrecognized output (background launch, error) → quiet line -->
  <ToolDisclosure v-else :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="help-circle" size="sm" /></template>
    <span class="tl-name">{{ label }}</span>
    <span v-if="summary" class="tl-dim">{{ summary }}</span>
    <template #trailing>
      <span v-if="chip" class="tl-chip">{{ chip }}</span>
    </template>
    <template #body>
      <!-- Not the answer payload (background launch / error): show the raw tool
           output instead of an empty option list. -->
      <OutputPanel :lines="tool.output" />
    </template>
  </ToolDisclosure>
</template>

<style scoped>
/* Receipt card — the question card's settled echo: raised surface, hairline
   border, lg radius and the lightest shadow, flush with the stream's left
   edge (block spacing is owned by ChatPane / TurnFold via .ask-receipt).
   Only the picks echo — the passed-over options are not shown. */
.ask-receipt {
  max-width: 560px;
  background: var(--color-surface-raised);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-xs);
  padding: var(--space-2) var(--space-3) 10px;
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
  color: var(--color-text);
}
.ask-receipt.flat {
  color: var(--color-text-faint);
  font-style: italic;
  padding-top: 6px;
  padding-bottom: 6px;
}

.rc-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  margin-bottom: 6px;
}
.rc-st { margin-left: auto; color: var(--color-success); display: inline-flex; }

.rc-q + .rc-q { margin-top: 6px; }
.rc-qtext {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: 3px;
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.rc-opt {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 1.5px 0;
  color: var(--color-text);
}
/* Per-question skip marker — same faint italic as the flat dismissed card. */
.rc-qskip {
  padding: 1.5px 0;
  color: var(--color-text-faint);
  font-style: italic;
}
.rc-lb { min-width: 0; }
.rc-ds { color: var(--color-text-faint); font-size: var(--text-xs); }

/* CSS radio / checkbox glyphs — same language as the live QuestionCard, one
   step smaller (14px) for the stream scale. */
.rc-g {
  width: 14px;
  height: 14px;
  flex: none;
  border: 0.5px solid var(--color-line-strong);
  position: relative;
}
.rc-g.chk { border-radius: var(--radius-xs); }
.rc-g.rad { border-radius: 50%; }
.rc-g.on { border-color: var(--color-accent); }
.rc-g.chk.on { background: var(--color-accent); }
.rc-g.chk.on::after {
  content: '';
  position: absolute;
  left: 3.5px;
  top: 0.5px;
  width: 4px;
  height: 8px;
  border-right: 1.5px solid var(--color-text-on-accent);
  border-bottom: 1.5px solid var(--color-text-on-accent);
  transform: rotate(45deg);
}
.rc-g.rad.on::after {
  content: '';
  position: absolute;
  inset: 2.5px;
  border-radius: 50%;
  background: var(--color-accent);
}
</style>
