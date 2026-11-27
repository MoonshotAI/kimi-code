<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { parseArgRecord, str } from '@moonshot-ai/app-components';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';
import { useToolCard, useToolCardExpansion, type ToolCardProps } from './useToolCard';

const props = withDefaults(defineProps<ToolCardProps>(), { mobile: false });
const argRecord = computed(() => parseArgRecord(props.tool.arg));
const skillName = computed(() => str(argRecord.value?.skill) ?? str(argRecord.value?.name) ?? '');
const skillArgs = computed(() => str(argRecord.value?.args) ?? '');
const { t } = useI18n();
const { status, summary, summaryFull, hasOutput } = useToolCard(props);
const showOutput = computed(() => status.value === 'error' && hasOutput.value);
const canExpand = computed(
  () => Boolean(skillArgs.value) || showOutput.value || summaryFull.value !== summary.value,
);
const { open } = useToolCardExpansion(props, canExpand);
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
