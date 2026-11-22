<script setup lang="ts">
import { useHistoryState } from '../historyState';
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { argFallbackText, parseArgRecord, str, urlHost } from '@moonshot-ai/app-components';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const { t } = useI18n();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');

const argText = computed(() => argFallbackText(props.tool.arg));

const url = computed(() => {
  const d = parseArgRecord(props.tool.arg);
  return str(d?.url) ?? str(d?.uri) ?? '';
});
const host = computed(() => (url.value ? urlHost(url.value) : ''));

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const canExpand = computed(() => hasOutput.value);
const open = useHistoryState(`tool:${props.tool.id}:open`, props.tool.defaultExpanded === true && canExpand.value);

watch(
  () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="globe" size="sm" /></template>
    <span class="tl-name">{{ t('tools.label.web_fetch') }}</span>
    <span v-if="host" class="tl-wrap">{{ host }}</span>
    <span v-else-if="argText" class="tl-dim">{{ argText }}</span>
    <template #body>
      <ToolPanel :title="host" :meta="url" :copy-text="url" scroll>
        <OutputPanel :lines="tool.output" :empty-text="t('tools.output.waiting')" />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

