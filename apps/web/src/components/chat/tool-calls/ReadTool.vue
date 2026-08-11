<!-- apps/kimi-web/src/components/chat/tool-calls/ReadTool.vue -->
<!-- Read tool: a file-centric quiet line. The row leads with the localized Read
     label, then the file name (a real button opening the preview) + its
     directory + the read line range; the trailing chip reports how many lines
     came back. Expanding shows the full path and the file content —
     syntax-highlighted with its real line numbers once the result is in (the
     Read output's <number>\t<content> prefixes become the gutter). While
     running, on error, or for output that doesn't match that shape (non-text
     files), the raw output panel is shown. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { FilePreviewRequest, ToolCall } from '../../../types';
import { basename } from '@moonshot-ai/app-core/lib';
import { parseReadOutput } from '@moonshot-ai/app-core/lib';
import { argFilePath, num, parseArgRecord, pathDirname } from './toolArgs';
import ToolDisclosure from './ToolDisclosure.vue';
import HighlightedCode from '../../HighlightedCode.vue';
import OutputPanel from './OutputPanel.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const emit = defineEmits<{ openFile: [target: FilePreviewRequest] }>();

const { t } = useI18n();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');

const args = computed(() => parseArgRecord(props.tool.arg));
const path = computed(() => argFilePath(args.value) ?? '');
const fileName = computed(() => (path.value ? basename(path.value) : ''));
const dirName = computed(() => (path.value ? pathDirname(path.value) : ''));

const startLine = computed(() => {
  const d = args.value;
  if (!d) return undefined;
  return num(d.offset) ?? num(d.line_start) ?? num(d.start_line);
});
const endLine = computed(() => {
  const d = args.value;
  if (!d) return undefined;
  const len = num(d.limit) ?? num(d.length);
  return num(d.line_end) ?? num(d.end_line) ?? (startLine.value !== undefined && len !== undefined ? startLine.value + len : undefined);
});
const range = computed(() => {
  if (startLine.value !== undefined && endLine.value !== undefined) return `:${startLine.value}-${endLine.value}`;
  if (startLine.value !== undefined) return `:${startLine.value}`;
  return '';
});

/** Only the settled, successful output is highlighted — streaming chunks would
    re-highlight the whole file per chunk, and errors aren't code. */
const parsed = computed(() => (props.tool.status === 'ok' ? parseReadOutput(props.tool.output ?? []) : null));
const contentRows = computed(() => parsed.value?.contents ?? []);
const lineNumbers = computed(() => parsed.value?.lineNumbers);

const lineCount = computed(() => parsed.value?.contents.length ?? props.tool.output?.length ?? 0);

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const canExpand = computed(() => parsed.value !== null || hasOutput.value);
const open = ref(props.tool.defaultExpanded === true && canExpand.value);

// The disclosure hides a collapsed body with the grid-rows animation, so slot
// content stays mounted. Mount the (tokenizing) highlighter only after the
// first expand; once mounted it stays mounted, so re-expanding does not
// re-highlight.
const everOpened = ref(open.value);
watch(open, (v) => {
  if (v) everOpened.value = true;
});

watch(
  () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);

function openFile(): void {
  if (!path.value) return;
  emit('openFile', { path: path.value, line: startLine.value });
}
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="file-text" size="sm" /></template>
    <span class="tl-name">{{ t('tools.label.read') }}</span>
    <button v-if="fileName" class="tl-file" type="button" @click.stop="openFile">{{ fileName }}</button>
    <span v-if="dirName" class="tl-faint">{{ dirName }}</span>
    <span v-if="range" class="tl-faint">{{ range }}</span>
    <span v-if="!fileName" class="tl-dim">{{ path || tool.arg }}</span>
    <template #trailing>
      <span v-if="lineCount > 0" class="tl-chip">{{ t('tools.chip.lines', { count: lineCount }) }}</span>
    </template>
    <template #body>
      <button v-if="path" class="path-link" type="button" @click="openFile">{{ path }}</button>
      <HighlightedCode v-if="parsed && everOpened" :code="contentRows" :path="path" :line-numbers="lineNumbers" />
      <OutputPanel v-else :lines="tool.output" :empty-text="t('tools.output.waiting')" />
    </template>
  </ToolDisclosure>
</template>

<style scoped>
/* Full-path link above the content panel — the row shows only the basename. */
.path-link {
  display: block;
  width: 100%;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  padding: 0 0 var(--space-1);
  font-family: var(--font-mono);
  font-size: calc(var(--content-font-size) - 2px);
  color: var(--color-text-muted);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.path-link:hover {
  color: var(--color-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.path-link:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
</style>
