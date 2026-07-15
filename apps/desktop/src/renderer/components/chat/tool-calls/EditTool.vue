<!-- apps/kimi-web/src/components/chat/tool-calls/EditTool.vue -->
<!-- Edit / Write tool card. Expanding the row inline shows the synthesized line
     diff when it accurately represents the operation (a single Edit); otherwise
     (Write, replace_all, error) the raw tool output is shown instead — on error
     the diff describes what was attempted, not what happened. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DiffViewLine, FilePreviewRequest, ToolCall, ToolMedia } from '../../../types';
import { diffStats } from '../../../lib/diffLines';
import { buildEditDiffLines } from '../../../lib/toolDiff';
import { toolGlyph, toolLabel, toolSummary } from '../../../lib/toolMeta';
import ToolRow from '../ToolRow.vue';
import DiffLines from '../DiffLines.vue';
import ToolOutputBlock from './ToolOutputBlock.vue';

const props = withDefaults(
  defineProps<{
    tool: ToolCall;
    mobile?: boolean;
    stackPosition?: 'single' | 'first' | 'middle' | 'last';
  }>(),
  { mobile: false, stackPosition: 'single' },
);

const emit = defineEmits<{
  openMedia: [media: ToolMedia];
  openFile: [target: FilePreviewRequest];
}>();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const label = computed(() => toolLabel(props.tool.name));
const glyph = computed(() => toolGlyph(props.tool.name));
const summary = computed(() => toolSummary(props.tool.name, props.tool.arg));
const summaryFull = computed(() => toolSummary(props.tool.name, props.tool.arg, true));

const editDiff = computed<DiffViewLine[] | null>(() => buildEditDiffLines(props.tool));
const chip = computed(() => {
  const diff = editDiff.value;
  if (diff && props.tool.status !== 'error') {
    const { added, removed } = diffStats(diff);
    if (added || removed) return `+${added} −${removed}`;
  }
  return '';
});

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const showDiff = computed(() => editDiff.value !== null && props.tool.status !== 'error');
const open = ref(false);
const canExpand = computed(() => showDiff.value || hasOutput.value);

function toggle(): void {
  if (canExpand.value) open.value = !open.value;
}
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
    <div v-if="summaryFull" class="bb-summary">{{ summaryFull }}</div>
    <div v-if="showDiff" class="diff-scroll">
      <DiffLines :lines="editDiff ?? []" :line-numbers="false" />
    </div>
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
/* Inline diff viewport: caps long diffs and scrolls horizontally for wide
   lines (DiffLines sizes itself to the longest row). */
.diff-scroll {
  margin-top: var(--space-2);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  overflow: auto;
  max-height: calc(24 * 1.5 * var(--ui-font-size));
}
</style>
