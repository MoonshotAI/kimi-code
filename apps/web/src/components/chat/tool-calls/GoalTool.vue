<!-- apps/kimi-web/src/components/chat/tool-calls/GoalTool.vue -->
<!-- Goal-mode tools (create / get / set budget / update): a status-flavoured
     quiet line. The row carries the objective (create), the new status as a
     coloured pill (update), or the budget (set budget); expanding shows the
     full objective + completion criterion and any tool output. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { ToolCall } from '../../../types';
import { normalizeToolName, toolLabel } from '../../../lib/toolMeta';
import { num, parseArgRecord, str } from './toolArgs';
import ToolDisclosure from './ToolDisclosure.vue';
import OutputPanel from './OutputPanel.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const { t } = useI18n();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const kind = computed(() => normalizeToolName(props.tool.name));

const args = computed(() => parseArgRecord(props.tool.arg));
const objective = computed(() => str(args.value?.objective) ?? '');
const criterion = computed(
  // Accept the backend's snake_case spelling too (the goal-snapshot mappers
  // normalize both) so the completion criterion never silently drops out.
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
const statusPillClass = computed(() => {
  switch (newStatus.value) {
    case 'complete':
      return 'pill-done';
    case 'blocked':
      return 'pill-blocked';
    default:
      return 'pill-active';
  }
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
const hasDetail = computed(() => Boolean(criterion.value) || (kind.value === 'creategoal' && hasOutput.value));
const canExpand = computed(() => hasDetail.value || hasOutput.value);
const open = ref(props.tool.defaultExpanded === true && canExpand.value);

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
    <template #trailing>
      <span v-if="kind === 'updategoal' && statusLabel" class="tl-pill" :class="statusPillClass">{{ statusLabel }}</span>
      <span v-else-if="kind === 'creategoal'" class="tl-pill pill-active">{{ t('status.goalStatusActive') }}</span>
    </template>
    <template #body>
      <div v-if="objective" class="goal-block">
        <div class="goal-text">{{ objective }}</div>
        <div v-if="criterion" class="goal-criterion">{{ criterion }}</div>
      </div>
      <OutputPanel v-if="hasOutput" :lines="tool.output" />
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.tl-pill.pill-active {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}
.tl-pill.pill-done {
  color: var(--color-success);
  background: var(--color-success-soft);
}
.tl-pill.pill-blocked {
  color: var(--color-warning);
  background: var(--color-warning-soft);
}

.goal-block {
  margin-bottom: var(--space-1);
}
.goal-text {
  color: var(--color-text);
  font-size: calc(var(--content-font-size) - 1px);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.goal-criterion {
  color: var(--color-text-muted);
  font-size: calc(var(--content-font-size) - 2px);
  line-height: 1.6;
  margin-top: 2px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
