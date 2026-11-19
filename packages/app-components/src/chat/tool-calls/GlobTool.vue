<script setup lang="ts">
import { useHistoryState } from '../historyState';
import { computed, inject, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { normalizeToolName } from '@moonshot-ai/app-components';
import { argFallbackText, parseArgRecord, str } from '@moonshot-ai/app-components';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const panelApi = inject(panelApiKey);

const { t } = useI18n();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const isGlob = computed(() => normalizeToolName(props.tool.name) === 'glob');

const args = computed(() => parseArgRecord(props.tool.arg));
const argText = computed(() => argFallbackText(props.tool.arg));
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
const open = useHistoryState(`tool:${props.tool.id}:open`, props.tool.defaultExpanded === true && canExpand.value);

watch(
  () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);

function openPath(path: string): void {
  const p = path.trim();
  if (!p) return;
  panelApi?.openFile({ path: p });
}
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon :name="isGlob ? 'tree-view' : 'list'" size="sm" /></template>
    <span class="tl-name">{{ t(isGlob ? 'tools.label.glob' : 'tools.label.ls') }}</span>
    <span v-if="isGlob && pattern" class="tl-mono">{{ pattern }}</span>
    <span v-else-if="!isGlob && dir" class="tl-mono">{{ dir }}</span>
    <span v-else-if="argText" class="tl-dim">{{ argText }}</span>
    <span v-if="isGlob && dir" class="tl-faint">{{ dir }}</span>
    <span v-if="isGlob && files.length > 0" class="tl-faint">{{ t('tools.chip.files', { count: files.length }) }}</span>
    <template #body>
      <ToolPanel scroll>
        <div v-if="isGlob" class="file-list">
          <button
            v-for="(file, i) in files"
            :key="i"
            class="file-row"
            type="button"
            :data-file-path="file.trim()"
            @click="openPath(file)"
          >
            {{ file }}
          </button>
        </div>
        <OutputPanel v-else :lines="tool.output" />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.file-list {
  display: flex;
  flex-direction: column;
}
.file-row {
  width: 100%;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  padding: 0;
  font-family: var(--font-mono);
  font-size: var(--content-font-size);
  line-height: 1.571;
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
  color: var(--color-accent);
}
.file-row:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
</style>
