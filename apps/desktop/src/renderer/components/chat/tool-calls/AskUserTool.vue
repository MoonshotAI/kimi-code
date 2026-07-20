<!-- apps/web/src/components/chat/tool-calls/AskUserTool.vue
     Result line for the AskUserQuestion tool. On a successful answer the
     output is a single JSON line ({ answers, note? }); answers are keyed by
     question text and the values are option labels (comma-joined for
     multi-select) or free-text (Other). Legacy transcripts instead carry
     synthesized ids (`q_<index>` keys, `opt_<q>_<o>` values) — both forms are
     resolved. We zip answers back to the input questions and echo the full
     option list, marking the picked option(s) selected and the rest faint —
     so the transcript shows both what was chosen and what was passed over.

     Background launches and error cases return plain-text output instead of
     the answer JSON; those fall back to a raw output view so the task id /
     failure reason is not hidden behind an empty option list. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/web-ui';
import type { FilePreviewRequest, ToolCall, ToolMedia } from '../../../types';
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
  openMedia: [media: ToolMedia];
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
function glyphFor(multiSelect: boolean, on: boolean): string {
  return multiSelect ? (on ? '■' : '□') : (on ? '●' : '○');
}

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

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const label = computed(() => toolLabel(props.tool.name));

watch(
  () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="help-circle" size="sm" /></template>
    <span class="tl-name">{{ label }}</span>
    <span v-if="summary" class="tl-dim">{{ summary }}</span>
    <template #trailing>
      <span v-if="chip" class="tl-chip">{{ chip }}</span>
    </template>
    <template #body>
      <div v-if="isDismissed" class="au-dismissed">{{ output.note }}</div>

      <div v-else-if="recognized" class="au-list">
        <div v-for="(q, qi) in questions" :key="qi" class="au-block">
          <div class="au-q">
            <span v-if="q.header" class="au-hdr">{{ q.header }}</span>
            <span class="au-qtext">{{ q.question }}</span>
          </div>
          <div class="au-opts">
            <div
              v-for="(opt, oi) in q.options"
              :key="oi"
              class="au-opt"
              :class="{ sel: isSelected(qi, oi) }"
            >
              <span class="au-glyph">{{ glyphFor(q.multiSelect, isSelected(qi, oi)) }}</span>
              <span class="au-label">{{ opt.label }}</span>
              <span v-if="opt.description" class="au-desc">{{ opt.description }}</span>
            </div>
            <div v-if="otherText(qi)" class="au-opt sel">
              <span class="au-glyph">{{ glyphFor(q.multiSelect, true) }}</span>
              <span class="au-label">{{ otherText(qi) }}</span>
            </div>
            <div v-if="isIndeterminate(qi)" class="au-opt sel">
              <span class="au-glyph">●</span>
              <span class="au-label">{{ t('tools.ask.answered') }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Not the answer payload (background launch / error): show the raw tool
           output instead of an empty option list. -->
      <OutputPanel v-else :lines="tool.output" />
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.au-dismissed {
  color: var(--color-text-muted);
  font-size: calc(var(--content-font-size) - 1px);
  line-height: var(--leading-normal);
  font-style: italic;
}

.au-list {
  display: flex;
  flex-direction: column;
  font-size: calc(var(--content-font-size) - 1px);
  line-height: var(--leading-normal);
}
.au-block {
  padding: var(--space-1) 0;
}
.au-block + .au-block {
  margin-top: var(--space-1);
  padding-top: 10px;
  border-top: 1px dashed var(--color-line);
}

.au-q {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: 6px;
}
.au-hdr {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  background: var(--color-surface-sunken);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-sm);
  padding: 0 6px;
  flex: none;
}
.au-qtext {
  color: var(--color-text);
  font-weight: var(--weight-medium);
}

.au-opts {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.au-opt {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 5px 10px;
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  color: var(--color-text-faint);
}
.au-opt.sel {
  border-color: var(--color-accent-bd);
  background: var(--color-accent-soft);
  color: var(--color-text);
}
.au-glyph {
  font-family: var(--font-mono);
  font-size: var(--text-base);
  color: var(--color-text-faint);
  width: 14px;
  text-align: center;
  flex: none;
}
.au-opt.sel .au-glyph {
  color: var(--color-accent-hover);
}
.au-label {
  color: inherit;
}
.au-desc {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  margin-left: 2px;
}
.au-opt.sel .au-desc {
  color: var(--color-text-muted);
}
</style>
