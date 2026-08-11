<!-- apps/web/src/components/chat/tool-calls/GlobTool.vue -->
<!-- Glob / Ls tools: file-listing quiet lines. The row leads with the
     localized Find / List label, then Glob's pattern in mono with a file-count
     chip; expanding lists the matched paths as rows that open the file
     preview. Ls keeps its output as a plain panel (the daemon formats entries
     itself). -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { FilePreviewRequest, ToolCall } from '../../../types';
import { normalizeToolName } from '../../../lib/toolMeta';
import { parseArgRecord, str } from './toolArgs';
import ToolDisclosure from './ToolDisclosure.vue';
import OutputPanel from './OutputPanel.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const emit = defineEmits<{ openFile: [target: FilePreviewRequest] }>();

const { t } = useI18n();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const isGlob = computed(() => normalizeToolName(props.tool.name) === 'glob');

const args = computed(() => parseArgRecord(props.tool.arg));
const pattern = computed(() => {
  const d = args.value;
  return str(d?.pattern) ?? str(d?.glob) ?? str(d?.query) ?? '';
});
const dir = computed(() => {
  const d = args.value;
  return str(d?.path) ?? str(d?.dir) ?? str(d?.directory) ?? str(d?.cwd) ?? '';
});

const files = computed(() => (props.tool.output ?? []).filter((l) => l.trim().length > 0));

const hasOutput = computed(() => files.value.length > 0);
const canExpand = computed(() => hasOutput.value);
const open = ref(props.tool.defaultExpanded === true && canExpand.value);

watch(
  () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);

function openPath(path: string): void {
  const p = path.trim();
  if (!p) return;
  emit('openFile', { path: p });
}
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon :name="isGlob ? 'tree-view' : 'list'" size="sm" /></template>
    <span class="tl-name">{{ t(isGlob ? 'tools.label.glob' : 'tools.label.ls') }}</span>
    <span v-if="isGlob && pattern" class="tl-mono">{{ pattern }}</span>
    <span v-else-if="!isGlob && dir" class="tl-mono">{{ dir }}</span>
    <span v-else class="tl-dim">{{ tool.arg }}</span>
    <span v-if="isGlob && dir" class="tl-faint">{{ dir }}</span>
    <template #trailing>
      <span v-if="isGlob && files.length > 0" class="tl-chip">{{ t('tools.chip.files', { count: files.length }) }}</span>
    </template>
    <template #body>
      <div v-if="isGlob" class="file-list">
        <button
          v-for="(file, i) in files"
          :key="i"
          class="file-row"
          type="button"
          @click="openPath(file)"
        >
          {{ file }}
        </button>
      </div>
      <OutputPanel v-else :lines="tool.output" />
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.file-list {
  display: flex;
  flex-direction: column;
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-well);
  padding: var(--space-1);
  max-height: calc(12 * 1.6 * var(--content-font-size));
  overflow-y: auto;
  overscroll-behavior: contain;
}
.file-row {
  width: 100%;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  padding: 2px var(--space-2);
  font-family: var(--font-mono);
  font-size: calc(var(--content-font-size) - 2px);
  line-height: 1.6;
  font-feature-settings: "liga" 0, "calt" 0;
  font-variant-ligatures: none;
  color: var(--color-text);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.file-row:hover {
  background: var(--color-hover);
  color: var(--color-accent);
}
.file-row:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
</style>
