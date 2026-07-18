<!-- apps/kimi-web/src/components/chat/tool-calls/ReadTool.vue -->
<!-- Read tool card. Once the result is in, expanding the row shows the file
     content syntax-highlighted with its real line numbers (the Read output's
     <number>\t<content> prefixes become the gutter). While running, on error,
     or for output that doesn't match that shape (non-text files), the raw
     tool output is shown instead. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { FilePreviewRequest, ToolCall, ToolMedia } from '../../../types';
import { parseReadOutput } from '../../../lib/readOutput';
import { toolFilePath } from '../../../lib/toolDiff';
import { toolChip, toolGlyph, toolLabel, toolSummary } from '../../../lib/toolMeta';
import ToolRow from '../ToolRow.vue';
import HighlightedCode from '../../HighlightedCode.vue';
import ToolOutputBlock from './ToolOutputBlock.vue';

const props = withDefaults(
  defineProps<{
    tool: ToolCall;
    mobile?: boolean;
    stackPosition?: 'single' | 'first' | 'middle' | 'last';
  }>(),
  { mobile: false, stackPosition: 'single' },
);

defineEmits<{
  openMedia: [media: ToolMedia];
  openFile: [target: FilePreviewRequest];
}>();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const label = computed(() => toolLabel(props.tool.name));
const glyph = computed(() => toolGlyph(props.tool.name));
const summary = computed(() => toolSummary(props.tool.name, props.tool.arg));
const summaryFull = computed(() => toolSummary(props.tool.name, props.tool.arg, true));
const chip = computed(() =>
  toolChip({
    name: props.tool.name,
    arg: props.tool.arg,
    output: props.tool.output,
    timing: props.tool.timing,
    status: props.tool.status,
  }),
);

const readPath = computed(() => toolFilePath(props.tool));
/** Only the settled, successful output is highlighted — streaming chunks would
    re-highlight the whole file per chunk, and errors aren't code. */
const parsed = computed(() => (props.tool.status === 'ok' ? parseReadOutput(props.tool.output ?? []) : null));
const contentRows = computed(() => parsed.value?.contents ?? []);
const lineNumbers = computed(() => parsed.value?.lineNumbers);

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const canExpand = computed(() => parsed.value !== null || hasOutput.value);
const open = ref(props.tool.defaultExpanded === true && canExpand.value);

// ToolRow hides a collapsed body purely with CSS, so slot content stays
// mounted. Mount the (tokenizing) highlighter only after the first expand;
// once mounted it stays mounted, so re-expanding does not re-highlight.
const everOpened = ref(open.value);
watch(open, (v) => {
  if (v) everOpened.value = true;
});

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
    :self-scrolling-body="parsed !== null"
    @toggle="toggle"
  >
    <template #trailing>
      <span v-if="chip" class="chip">{{ chip }}</span>
    </template>
    <div v-if="summaryFull" class="bb-summary">{{ summaryFull }}</div>
    <HighlightedCode v-if="parsed && everOpened" :code="contentRows" :path="readPath" :line-numbers="lineNumbers" />
    <ToolOutputBlock v-else :lines="tool.output" empty-text="Waiting for output…" />
  </ToolRow>
</template>

<style scoped>
.chip {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  flex: none;
}
.bb-summary {
  color: var(--color-text);
  border-bottom: 1px dashed var(--color-line);
  padding-bottom: 6px;
  margin-bottom: 6px;
  word-break: break-all;
}
</style>
