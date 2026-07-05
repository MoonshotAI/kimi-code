<!-- apps/kimi-web/src/components/chat/tool-calls/AskUserTool.vue
     Result card for the AskUserQuestion tool. The tool's output arrives as a
     single JSON line ({ answers, note? }); answers are keyed by synthesized
     question id (`q_<index>`) and the values are synthesized option ids
     (`opt_<q>_<o>`, comma-joined for multi-select) or free-text (Other). We
     zip answers back to the input questions by index and echo the full option
     list, marking the picked option(s) selected and the rest faint — so the
     transcript shows both what was chosen and what was passed over. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { FilePreviewRequest, ToolCall, ToolMedia } from '../../../types';
import { toolGlyph, toolLabel } from '../../../lib/toolMeta';
import {
  parseAskInput,
  parseAskOutput,
  resolveAnswer,
} from './askUserToolParse';
import ToolRow from '../ToolRow.vue';

const props = withDefaults(
  defineProps<{
    tool: ToolCall;
    mobile?: boolean;
    stackPosition?: 'single' | 'first' | 'middle' | 'last';
    toolDiffPanel?: boolean;
  }>(),
  { mobile: false, stackPosition: 'single', toolDiffPanel: false },
);

defineEmits<{
  openMedia: [media: ToolMedia];
  openFile: [target: FilePreviewRequest];
  openToolDiff: [id: string];
}>();

const SUMMARY_MAX = 80;

function clip(s: string, max = SUMMARY_MAX): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

const questions = computed(() => parseAskInput(props.tool.arg));
const output = computed(() => parseAskOutput(props.tool.output));
const isDismissed = computed(
  () => Object.keys(output.value.answers).length === 0 && output.value.note.length > 0,
);
const resolved = computed(() =>
  questions.value.map((_, i) => resolveAnswer(output.value.answers[`q_${i}`])),
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
  if (isDismissed.value) return 'Dismissed';
  const first = questions.value[0]?.question ?? '';
  const base = clip(first);
  if (questions.value.length <= 1) return base;
  return `${base}  (+${questions.value.length - 1} more)`;
});

const chip = computed(() => {
  if (isDismissed.value) return 'Dismissed';
  if (answeredCount.value === 0) return '';
  return `${answeredCount.value} ${answeredCount.value === 1 ? 'answer' : 'answers'}`;
});

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const canExpand = computed(() => questions.value.length > 0 || isDismissed.value || hasOutput.value);
const open = ref(props.tool.defaultExpanded === true && canExpand.value);

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const label = computed(() => toolLabel(props.tool.name));
const glyph = computed(() => toolGlyph(props.tool.name));

function toggle(): void {
  if (canExpand.value) open.value = !open.value;
}

watch(
  () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);
</script>

<template>
  <ToolRow
    :status="status"
    :icon="glyph"
    :name="label"
    :arg="!open ? summary : ''"
    :time="tool.timing"
    :open="open"
    :expandable="canExpand"
    :stacked="stackPosition !== 'single'"
    :stack-position="stackPosition"
    @toggle="toggle"
  >
    <template #trailing>
      <span v-if="chip" class="chip">{{ chip }}</span>
    </template>

    <div v-if="isDismissed" class="au-dismissed">{{ output.note }}</div>

    <div v-else class="au-list">
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
            <span class="au-label">Answered</span>
          </div>
        </div>
      </div>
    </div>
  </ToolRow>
</template>

<style scoped>
.chip {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  flex: none;
}

.au-dismissed {
  color: var(--color-text-muted);
  font: italic var(--text-sm)/var(--leading-normal) var(--font-ui);
}

.au-list {
  display: flex;
  flex-direction: column;
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
}
.au-block {
  padding: 4px 0;
}
.au-block + .au-block {
  margin-top: 4px;
  padding-top: 10px;
  border-top: 1px dashed var(--color-line);
}

.au-q {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}
.au-hdr {
  font: var(--text-xs) var(--font-mono);
  color: var(--color-text-muted);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
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
  gap: 4px;
}
.au-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  color: var(--color-text-faint);
}
.au-opt.sel {
  border-color: var(--color-accent-bd);
  background: var(--color-accent-soft);
  color: var(--color-text);
}
.au-glyph {
  font: var(--text-base) var(--font-mono);
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
