<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, Icon } from '@moonshot-ai/app-ui';
import { formatDuration, parseWaitForResult, type WaitForResult } from '@moonshot-ai/app-core/lib';
import { str } from './toolArgs';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';
import { useToolCard, useToolCardExpansion, type ToolCardProps } from './useToolCard';

const props = withDefaults(defineProps<ToolCardProps>(), { mobile: false });
const taskId = computed(() => str(args.value?.task_id) ?? str(args.value?.taskId));

const result = computed(() => (status.value === 'error' ? null : parseWaitForResult(props.tool.output)));

const FINISHED_STATUS_KEYS: Record<string, string> = {
  completed: 'conversation.notification.status.completed',
  failed: 'conversation.notification.status.failed',
  timed_out: 'conversation.notification.status.timed_out',
  killed: 'conversation.notification.status.killed',
  lost: 'conversation.notification.status.lost',
};

const finishedStatusLabel = computed(() => {
  const s = result.value?.finishedStatus;
  if (!s) return '';
  const key = FINISHED_STATUS_KEYS[s];
  return key ? t(key) : s;
});

const statusBadgeVariant = computed<'success' | 'danger' | 'warning' | 'neutral'>(() => {
  switch (result.value?.finishedStatus) {
    case 'completed':
      return 'success';
    case 'failed':
    case 'lost':
      return 'danger';
    case 'timed_out':
    case 'killed':
      return 'warning';
    default:
      return 'neutral';
  }
});

const firstOutputLine = computed(() => props.tool.output?.find((line) => line.trim().length > 0) ?? '');

const headline = computed(() => {
  if (status.value === 'running') {
    return taskId.value ? t('tools.waitfor.waitingTask', { id: taskId.value }) : t('tools.waitfor.waitingAny');
  }
  if (status.value === 'error') return firstOutputLine.value;
  const r = result.value;
  if (!r) return taskId.value ?? firstOutputLine.value;
  switch (r.status) {
    case 'completed':
      return r.finishedDescription ?? r.taskId ?? '';
    case 'timed_out':
      return r.runningCount > 0 ? t('tools.waitfor.stillRunning', { count: r.runningCount }) : t('tools.waitfor.timedOut');
    case 'interrupted':
      return t('tools.waitfor.interrupted');
    case 'no_tasks':
      return t('tools.waitfor.noTasks');
  }
});

const waited = computed(() => {
  const r = result.value;
  if (!r || r.status === 'no_tasks') return '';
  return formatDuration(r.waitedMs);
});
const chip = computed(() => waited.value || props.tool.timing || '');

function runningTasksText(r: WaitForResult): string {
  if (r.runningSamples.length === 0) return '';
  const lines = [...r.runningSamples];
  const remaining = r.runningCount - r.runningSamples.length;
  if (remaining > 0) lines.push(t('tools.waitfor.moreRunning', { count: remaining }));
  return lines.join('\n');
}

const RESULT_KEYS: Record<WaitForResult['status'], string> = {
  completed: 'tools.waitfor.result.completed',
  timed_out: 'tools.waitfor.timedOut',
  interrupted: 'tools.waitfor.result.interrupted',
  no_tasks: 'tools.waitfor.noTasks',
};

const details = computed(() => {
  const r = result.value;
  if (!r) return [];
  const completed = r.status === 'completed';
  return [
    { key: 'result', label: t('tools.waitfor.field.result'), value: t(RESULT_KEYS[r.status]), mono: false },
    { key: 'task', label: t('tools.waitfor.field.task'), value: r.taskId ?? '', mono: true },
    { key: 'taskStatus', label: t('tools.waitfor.field.taskStatus'), value: completed ? finishedStatusLabel.value : '', mono: false },
    { key: 'description', label: t('tools.waitfor.field.description'), value: completed ? (r.finishedDescription ?? '') : '', mono: false },
    { key: 'waited', label: t('tools.waitfor.field.waited'), value: waited.value, mono: false },
    { key: 'timeout', label: t('tools.waitfor.field.timeout'), value: r.timeoutMs === undefined ? '' : formatDuration(r.timeoutMs), mono: false },
    { key: 'finishedDuringWait', label: t('tools.waitfor.field.finishedDuringWait'), value: r.extraCount > 0 ? String(r.extraCount) : '', mono: false },
    { key: 'stillRunning', label: t('tools.waitfor.field.stillRunning'), value: r.runningCount > 0 ? String(r.runningCount) : '', mono: false },
    { key: 'runningTasks', label: t('tools.waitfor.field.runningTasks'), value: runningTasksText(r), mono: false },
    { key: 'warning', label: t('tools.waitfor.field.warning'), value: r.warning ?? '', mono: false },
  ].filter((row) => row.value !== '');
});

const { t } = useI18n();
const { status, args, hasOutput, toolNameLabel } = useToolCard(props);
const canExpand = computed(() => details.value.length > 0 || hasOutput.value);
const { open } = useToolCardExpansion(props, canExpand);
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon name="clock" size="sm" /></template>
    <span class="tl-name">{{ toolNameLabel }}</span>
    <span v-if="headline" class="tl-dim">{{ headline }}</span>
    <span v-if="chip" class="tl-faint">{{ chip }}</span>
    <template #trailing>
      <Badge v-if="result?.status === 'timed_out'" variant="warning" size="sm">{{ t('tools.waitfor.timedOut') }}</Badge>
      <Badge v-else-if="result?.status === 'completed' && finishedStatusLabel" :variant="statusBadgeVariant" size="sm">{{ finishedStatusLabel }}</Badge>
    </template>
    <template #body>
      <ToolPanel scroll>
        <dl v-if="details.length > 0" class="wf-fields">
          <template v-for="row in details" :key="row.key">
            <dt>{{ row.label }}</dt>
            <dd :class="{ mono: row.mono }">{{ row.value }}</dd>
          </template>
        </dl>
        <OutputPanel v-if="result?.outputPreview" class="wf-output" :lines="result.outputPreview.split('\n')" />
        <OutputPanel
          v-if="details.length === 0 && hasOutput"
          :lines="tool.output"
          :empty-text="status === 'running' ? t('tools.output.waiting') : t('tools.output.empty')"
        />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.wf-fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--space-1) var(--space-3);
  margin: 0;
  font-size: var(--text-base);
  line-height: 20px;
}
.wf-fields dt {
  color: var(--color-text-faint);
}
.wf-fields dd {
  margin: 0;
  min-width: 0;
  color: var(--color-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.wf-fields dd.mono {
  font-family: var(--font-mono);
}
.wf-output {
  margin-top: var(--space-2);
}
</style>
