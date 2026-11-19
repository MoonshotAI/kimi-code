<script setup lang="ts">
import { useHistoryState } from '../historyState';
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { parseArgRecord, str, toolSummary } from '@moonshot-ai/app-components';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const { t } = useI18n();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');

const argRecord = computed(() => parseArgRecord(props.tool.arg));
const skillName = computed(() => str(argRecord.value?.skill) ?? str(argRecord.value?.name) ?? '');
const skillArgs = computed(() => str(argRecord.value?.args) ?? '');

const summary = computed(() => toolSummary(props.tool.name, props.tool.arg));
const summaryFull = computed(() => toolSummary(props.tool.name, props.tool.arg, true));

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const showOutput = computed(() => status.value === 'error' && hasOutput.value);
const canExpand = computed(
  () => Boolean(skillArgs.value) || showOutput.value || summaryFull.value !== summary.value,
);
const open = useHistoryState(`tool:${props.tool.id}:open`, props.tool.defaultExpanded === true && canExpand.value);

watch(
  () => [props.tool.defaultExpanded, props.tool.output?.length, props.tool.status, props.tool.name] as const,
  () => {
    if (props.tool.defaultExpanded === true && canExpand.value) open.value = true;
  },
);
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="bolt" size="sm" /></template>
    <span class="tl-name">{{ t('tools.label.skill') }}</span>
    <span v-if="summary" class="tl-dim">{{ summary }}</span>
    <span v-if="tool.timing" class="tl-faint">{{ tool.timing }}</span>
    <template #body>
      <ToolPanel :title="skillName" :copy-text="skillArgs" scroll>
        <div v-if="skillArgs" class="st-args">{{ skillArgs }}</div>
        <div v-else-if="!skillName" class="st-args">{{ summaryFull }}</div>
        <OutputPanel v-if="showOutput" :lines="tool.output" :empty-text="t('tools.output.empty')" />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.st-args {
  color: var(--color-text-muted);
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
