<!-- apps/kimi-web/src/components/chat/tool-calls/EditTool.vue -->
<!-- Edit / MultiEdit / Write tool: a diff-centric quiet line. The row leads
     with the localized Edit / Write label, then the file name (a button opening
     the preview) + directory, with the change stats and a mini segmented
     add/del bar trailing. Expanding shows, syntax-highlighted: the synthesized
     line diff for a single Edit / well-formed MultiEdit, or the written
     content for a Write (the client cannot tell a new file from an overwrite,
     so a from-empty diff would mislead); otherwise (replace_all, error) the
     raw output panel is shown — on error the diff describes what was
     attempted, not what happened. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { DiffViewLine, FilePreviewRequest, ToolCall } from '../../../types';
import { diffStats } from '../../../lib/diffLines';
import { buildEditDiffLines, buildWriteContent } from '../../../lib/toolDiff';
import { normalizeToolName } from '../../../lib/toolMeta';
import { basename } from '@moonshot-ai/app-core/lib';
import { argFilePath, parseArgRecord, pathDirname } from './toolArgs';
import ToolDisclosure from './ToolDisclosure.vue';
import HighlightedCode from '../../HighlightedCode.vue';
import OutputPanel from './OutputPanel.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const emit = defineEmits<{ openFile: [target: FilePreviewRequest] }>();

const { t } = useI18n();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const isWrite = computed(() => normalizeToolName(props.tool.name) === 'write');

const path = computed(() => argFilePath(parseArgRecord(props.tool.arg)) ?? '');
const fileName = computed(() => (path.value ? basename(path.value) : ''));
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
const open = ref(false);

// The disclosure hides a collapsed body with the grid-rows animation, so slot
// content stays mounted. Mount the (tokenizing) highlighter only after the
// first expand; once mounted it stays mounted, so re-expanding does not
// re-highlight.
const everOpened = ref(open.value);
watch(open, (v) => {
  if (v) everOpened.value = true;
});

function openFile(): void {
  if (!path.value) return;
  emit('openFile', { path: path.value });
}
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon :name="isWrite ? 'file-plus' : 'pencil'" size="sm" /></template>
    <span class="tl-name">{{ isWrite ? t('tools.label.write') : t('tools.label.edit') }}</span>
    <button v-if="fileName" class="tl-file" type="button" @click.stop="openFile">{{ fileName }}</button>
    <span v-else class="tl-dim">{{ path || tool.arg }}</span>
    <span v-if="dirName" class="tl-faint">{{ dirName }}</span>
    <template #trailing>
      <template v-if="hasStats">
        <span v-if="stats.added > 0" class="tl-add">+{{ stats.added }}</span>
        <span v-if="stats.removed > 0" class="tl-del">−{{ stats.removed }}</span>
        <span class="diffbar" aria-hidden="true">
          <span class="seg-add" :style="{ flexGrow: stats.added }" />
          <span class="seg-del" :style="{ flexGrow: stats.removed }" />
        </span>
      </template>
      <span v-else-if="isWrite && status === 'ok'" class="tl-chip">{{ t('tools.chip.created') }}</span>
    </template>
    <template #body>
      <HighlightedCode v-if="showDiff && everOpened" :lines="editDiff ?? []" :path="path" />
      <HighlightedCode
        v-else-if="showContent && everOpened"
        :code="writeContent?.content ?? ''"
        :path="writeContent?.path"
      />
      <OutputPanel v-else :lines="tool.output" :empty-text="t('tools.output.waiting')" />
    </template>
  </ToolDisclosure>
</template>

<style scoped>
/* Mini add/del proportion bar — the change's shape at a glance. */
.diffbar {
  display: inline-flex;
  width: 36px;
  height: 3px;
  border-radius: var(--radius-full);
  overflow: hidden;
  gap: 1px;
  flex: none;
}
.seg-add {
  background: var(--color-success);
}
.seg-del {
  background: var(--color-danger);
}
</style>
