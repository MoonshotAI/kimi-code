<script setup lang="ts">
import { useHistoryState } from '../historyState';
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { normalizeToolName, toolLabel } from '@moonshot-ai/app-components';
import { num, parseArgRecord, str } from '@moonshot-ai/app-components';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';
import { updateGoalVisibleOutput } from './goalToolOutput';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const { t } = useI18n();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const kind = computed(() => normalizeToolName(props.tool.name));

const args = computed(() => parseArgRecord(props.tool.arg));
const objective = computed(() => str(args.value?.objective) ?? '');
const criterion = computed(
  () => str(args.value?.completionCriterion) ?? str(args.value?.completion_criterion) ?? '',
);

const GOAL_STATUS_KEYS: Record<string, string> = {
  active: 'status.goalStatusActive',
  blocked: 'status.goalStatusBlocked',
  complete: 'status.goalStatusComplete',
};

const newStatus = computed(() => str(args.value?.status) ?? '');
const statusLabel = computed(() => {
  const key = GOAL_STATUS_KEYS[newStatus.value];
  return key ? t(key) : newStatus.value;
});
const budget = computed(() => {
  const value = num(args.value?.value);
  const unit = str(args.value?.unit);
  if (value === undefined || !unit) return '';
  const known = ['turns', 'tokens', 'milliseconds', 'seconds', 'minutes', 'hours'];
  return known.includes(unit)
    ? t(`tools.goal.${unit}`, { value })
    : t('tools.goal.budget', { value, unit });
});

const headline = computed(() => {
  switch (kind.value) {
    case 'creategoal':
      return objective.value;
    case 'updategoal':
      return statusLabel.value;
    case 'setgoalbudget':
      return budget.value;
    default:
      return '';
  }
});

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const visibleOutput = computed(() => {
  const lines = props.tool.output ?? [];
  return kind.value === 'updategoal' ? updateGoalVisibleOutput(lines) : lines;
});
const hasDetail = computed(() => Boolean(criterion.value) || (kind.value === 'creategoal' && hasOutput.value));
const canExpand = computed(() => hasDetail.value || hasOutput.value);
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
    <template #leading><Icon name="target" size="sm" /></template>
    <span class="tl-name">{{ toolLabel(tool.name) }}</span>
    <span v-if="headline" class="tl-dim">{{ headline }}</span>
    <span v-if="kind === 'creategoal'" class="tl-faint">{{ t('status.goalStatusActive') }}</span>
    <template #body>
      <ToolPanel scroll>
        <div v-if="objective" class="goal-block">
          <div class="goal-text">{{ objective }}</div>
          <div v-if="criterion" class="goal-criterion">{{ criterion }}</div>
        </div>
        <OutputPanel v-if="hasOutput" :lines="visibleOutput" />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.goal-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.goal-text {
  color: var(--color-text);
  font-size: var(--content-font-size);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  word-break: break-word;
}
.goal-criterion {
  color: var(--color-text-muted);
  font-size: var(--content-font-size);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
