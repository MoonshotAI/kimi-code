<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, Tooltip } from '@moonshot-ai/app-ui';
import { basename } from '@moonshot-ai/app-core/lib';
import { parseReadOutput } from '@moonshot-ai/app-core/lib';
import { argFilePath, num } from './toolArgs';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import HighlightedCode from '../../HighlightedCode.vue';
import OutputPanel from './OutputPanel.vue';
import { useToolCard, useToolCardExpansion, type ToolCardProps } from './useToolCard';

const props = withDefaults(defineProps<ToolCardProps>(), { mobile: false });
const { t } = useI18n();
const { panelApi, status, args, argText, hasOutput } = useToolCard(props);

const path = computed(() => argFilePath(args.value) ?? '');
const fileName = computed(() => (path.value ? basename(path.value) : ''));

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

const parsed = computed(() => (props.tool.status === 'ok' ? parseReadOutput(props.tool.output ?? []) : null));
const contentRows = computed(() => parsed.value?.contents ?? []);
const lineNumbers = computed(() => parsed.value?.lineNumbers);

const lineCount = computed(() => parsed.value?.contents.length ?? props.tool.output?.length ?? 0);

const panelTitle = computed(() => fileName.value || path.value);
const copyText = computed(() => (parsed.value ? contentRows.value.join('\n') : (props.tool.output ?? []).join('\n')));

const canExpand = computed(() => parsed.value !== null || hasOutput.value);
const { open } = useToolCardExpansion(props, canExpand);

const everOpened = ref(open.value);
watch(open, (v) => {
  if (v) everOpened.value = true;
});

function openFile(): void {
  if (!path.value) return;
  panelApi?.openFile({ path: path.value, line: startLine.value });
}
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="file-text" size="sm" /></template>
    <span class="tl-name">{{ t('tools.label.read') }}</span>
    <Tooltip v-if="fileName" :text="path">
      <button class="tl-file" type="button" :data-file-path="path" @click.stop="openFile">{{ fileName }}</button>
    </Tooltip>
    <span v-if="range" class="tl-faint">{{ range }}</span>
    <span v-if="!fileName && (path || argText)" class="tl-dim">{{ path || argText }}</span>
    <span v-if="lineCount > 0" class="tl-faint">{{ t('tools.chip.lines', { count: lineCount }) }}</span>
    <template #body>
      <ToolPanel :title="panelTitle" :copy-text="copyText" scroll>
        <HighlightedCode v-if="parsed && everOpened" :code="contentRows" :path="path" :line-numbers="lineNumbers" :framed="false" />
        <OutputPanel v-else :lines="tool.output" :empty-text="t('tools.output.waiting')" />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

