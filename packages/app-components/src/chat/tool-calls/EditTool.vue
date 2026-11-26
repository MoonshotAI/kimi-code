<script setup lang="ts">
import { useHistoryState } from '../historyState';
import { computed, ref, watch } from 'vue';
import { Icon, Tooltip } from '@moonshot-ai/app-ui';
import type { DiffViewLine } from '@moonshot-ai/app-core/client/types';
import { diffStats } from '@moonshot-ai/app-core/client';
import { buildEditDiffLines, buildWriteContent } from '@moonshot-ai/app-core/client';
import { basename } from '@moonshot-ai/app-core/lib';
import { argFallbackText, argFilePath, parseArgRecord, pathDirname } from '@moonshot-ai/app-components';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import HighlightedCode from '../../HighlightedCode.vue';
import OutputPanel from './OutputPanel.vue';
import { useToolCard, type ToolCardProps } from './useToolCard';

const props = withDefaults(defineProps<ToolCardProps>(), { mobile: false });
const { t, panelApi, status, kind } = useToolCard(props);
const isWrite = computed(() => kind.value === 'write');

const path = computed(() => argFilePath(parseArgRecord(props.tool.arg)) ?? '');
const fileName = computed(() => (path.value ? basename(path.value) : ''));
const pathText = computed(() => path.value || argFallbackText(props.tool.arg));
const dirName = computed(() => (path.value ? pathDirname(path.value) : ''));

const editDiff = computed<DiffViewLine[] | null>(() => buildEditDiffLines(props.tool));
const writeContent = computed(() => buildWriteContent(props.tool));
const stats = computed(() => {
  const diff = editDiff.value;
  if (!diff || props.tool.status === 'error') return { added: 0, removed: 0 };
  return diffStats(diff);
});
const hasStats = computed(() => stats.value.added > 0 || stats.value.removed > 0);

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const showDiff = computed(() => editDiff.value !== null && props.tool.status !== 'error');
const showContent = computed(() => writeContent.value !== null && props.tool.status !== 'error');
const canExpand = computed(() => showDiff.value || showContent.value || hasOutput.value);
const open = useHistoryState(`tool:${props.tool.id}:open`, false);

const everOpened = ref(open.value);
watch(open, (v) => {
  if (v) everOpened.value = true;
});

const DIFF_PREFIX = { add: '+', del: '-', context: ' ', hunk: '' } as const;

function diffLineText(line: DiffViewLine): string {
  return DIFF_PREFIX[line.type] + line.text;
}

const copyText = computed(() => {
  if (showDiff.value) return (editDiff.value ?? []).map(diffLineText).join('\n');
  if (showContent.value) return writeContent.value?.content ?? '';
  return (props.tool.output ?? []).join('\n');
});

function openFile(): void {
  if (!path.value) return;
  panelApi?.openFile({ path: path.value });
}
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon :name="isWrite ? 'file-plus' : 'pencil'" size="sm" /></template>
    <span class="tl-name">{{ isWrite ? t('tools.label.write') : t('tools.label.edit') }}</span>
    <template v-if="!open">
      <Tooltip v-if="fileName" :text="path">
        <button class="tl-file" type="button" :data-file-path="path" @click.stop="openFile">{{ fileName }}</button>
      </Tooltip>
      <span v-if="!fileName && pathText" class="tl-dim">{{ pathText }}</span>
      <template v-if="hasStats">
        <span v-if="stats.added > 0" class="tl-add">+{{ stats.added }}</span>
        <span v-if="stats.removed > 0" class="tl-del">−{{ stats.removed }}</span>
      </template>
    </template>
    <template #trailing>
      <span v-if="!hasStats && isWrite && status === 'ok'" class="tl-chip">{{ t('tools.chip.created') }}</span>
    </template>
    <template #body>
      <ToolPanel flush scroll :copy-text="copyText">
        <template #head>
          <span class="ed-path">
            <span v-if="dirName" class="ed-dir">{{ dirName }}/</span>
            <button v-if="fileName" class="ed-file ed-open" type="button" :data-file-path="path" @click.stop="openFile">{{ fileName }}</button>
            <span v-else class="ed-file">{{ pathText }}</span>
          </span>
          <span v-if="hasStats" class="ed-stats">
            <span v-if="stats.added > 0" class="ed-add">+{{ stats.added }}</span>
            <span v-if="stats.removed > 0" class="ed-del">−{{ stats.removed }}</span>
          </span>
        </template>
        <HighlightedCode v-if="showDiff && everOpened" :lines="editDiff ?? []" :path="path" :framed="false" />
        <HighlightedCode
          v-else-if="showContent && everOpened"
          :code="writeContent?.content ?? ''"
          :path="writeContent?.path"
          :framed="false"
        />
        <OutputPanel v-else :lines="tool.output" :empty-text="t('tools.output.waiting')" />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.ed-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ed-dir {
  color: var(--color-text-faint);
}
.ed-file {
  color: var(--color-text);
}
.ed-open {
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.ed-open:hover {
  color: var(--color-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.ed-open:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.ed-stats {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex: none;
}
.ed-add {
  color: var(--color-diff-add-fg);
}
.ed-del {
  color: var(--color-diff-del-fg);
}
</style>
