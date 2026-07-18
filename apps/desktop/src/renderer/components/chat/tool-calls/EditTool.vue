<!-- apps/kimi-web/src/components/chat/tool-calls/EditTool.vue -->
<!-- Edit / Write tool card. Expanding the row inline shows, syntax-highlighted:
     the synthesized line diff for a single Edit, or the written content for a
     Write (the client cannot tell a new file from an overwrite, so a from-empty
     diff would mislead); otherwise (replace_all, error) the raw tool output is
     shown instead — on error the diff describes what was attempted, not what
     happened. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DiffViewLine, FilePreviewRequest, ToolCall, ToolMedia } from '../../../types';
import { diffStats } from '../../../lib/diffLines';
import { buildEditDiffLines, buildWriteContent, toolFilePath } from '../../../lib/toolDiff';
import { toolGlyph, toolLabel, toolSummary } from '../../../lib/toolMeta';
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
const editPath = computed(() => toolFilePath(props.tool));
const writeContent = computed(() => buildWriteContent(props.tool));
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
const showContent = computed(() => writeContent.value !== null && props.tool.status !== 'error');
const open = ref(false);
const canExpand = computed(() => showDiff.value || showContent.value || hasOutput.value);
/** True when the expanded body is the HighlightedCode block (which owns its
    scroll viewport), false for the ToolOutputBlock fallback. */
const showHighlighted = computed(() => showDiff.value || showContent.value);

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
    :self-scrolling-body="showHighlighted"
    @toggle="toggle"
  >
    <template #trailing>
      <span v-if="chip" class="chip">{{ chip }}</span>
    </template>
    <div v-if="summaryFull" class="bb-summary">{{ summaryFull }}</div>
    <HighlightedCode v-if="showDiff && everOpened" :lines="editDiff ?? []" :path="editPath" />
    <HighlightedCode
      v-else-if="showContent && everOpened"
      :code="writeContent?.content ?? ''"
      :path="writeContent?.path"
    />
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
