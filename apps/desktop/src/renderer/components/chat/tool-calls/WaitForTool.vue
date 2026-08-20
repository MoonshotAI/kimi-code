<!-- apps/web/src/components/chat/tool-calls/WaitForTool.vue -->
<!-- WaitFor (wait for background tasks): a status-flavoured quiet line. The
     row carries the wait target (while running) or the finished task's
     description (once settled); a timed-out wait is NOT an error (the tool
     says so itself) and renders as a warning Badge, while a finished task
     carries its terminal status as a coloured Badge and the waited span as a
     trailing chip. While running, the body holds the server's single live
     status line — the per-second progress update arrives with `replace` and
     the reducer rewrites it in place, so it never accumulates. Once settled,
     expanding shows the glance summary (finished task, counts of tasks
     finished during the wait / still running) plus the raw timeline output.
     Unrecognized output degrades to the raw panel, like GenericTool. -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, Icon } from '@moonshot-ai/app-ui';
import { formatDuration, parseWaitForResult, type WaitForResult } from '@moonshot-ai/app-core/lib';
import type { ToolCall } from '../../../types';
import { toolLabel } from '../../../lib/toolMeta';
import { parseArgRecord, str } from './toolArgs';
import ToolDisclosure from './ToolDisclosure.vue';
import OutputPanel from './OutputPanel.vue';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const { t } = useI18n();

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');

const args = computed(() => parseArgRecord(props.tool.arg));
const taskId = computed(() => str(args.value?.task_id) ?? str(args.value?.taskId));

// Error output is plain text (e.g. "Task not found: bg_x"), not the timeline —
// leave it to the raw panel instead of trying to parse it.
const result = computed(() => (status.value === 'error' ? null : parseWaitForResult(props.tool.output)));

// Terminal statuses a waited task can settle into (agent-core AgentTaskStatus),
// mapped to the shared notification-status vocabulary.
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
  // Settled but unrecognized output (a server version skew, a new
  // wait_status): keep the collapsed row informative — fall back to the waited
  // task's id, then to the first raw output line, instead of a bare label.
  if (!r) return taskId.value ?? firstOutputLine.value;
  switch (r.status) {
    case 'completed':
      return r.finishedDescription ?? r.taskId ?? '';
    case 'timed_out':
      return r.runningCount > 0 ? t('tools.waitfor.stillRunning', { count: r.runningCount }) : t('tools.waitfor.timedOut');
    case 'no_tasks':
      return t('tools.waitfor.noTasks');
  }
});

// The waited span is the authoritative chip (same source as the TUI chip);
// fall back to the wire timing while running / on unrecognized output.
const waited = computed(() => {
  const r = result.value;
  if (!r || r.status === 'no_tasks') return '';
  return formatDuration(r.waitedMs);
});
const chip = computed(() => waited.value || props.tool.timing || '');

// Glance block above the raw output: the finished task at a glance, then the
// counts the wait came back with (extras finished during the wait, tasks
// still running with a few sampled descriptions).
function samplesLine(r: WaitForResult): string | null {
  if (r.runningSamples.length === 0) return null;
  const samples = [...r.runningSamples];
  const remaining = r.runningCount - r.runningSamples.length;
  if (remaining > 0) samples.push(t('tools.waitfor.moreRunning', { count: remaining }));
  return samples.join(', ');
}

const glance = computed<{ main: string; subs: string[] } | null>(() => {
  const r = result.value;
  if (!r) return null;
  if (r.status === 'completed') {
    const main = [r.taskId, finishedStatusLabel.value].filter((part) => part).join(' · ');
    const subs: string[] = [];
    if (r.finishedDescription) subs.push(r.finishedDescription);
    const parts: string[] = [];
    if (r.extraCount > 0) parts.push(t('tools.waitfor.moreFinished', { count: r.extraCount }));
    if (r.runningCount > 0) parts.push(t('tools.waitfor.stillRunning', { count: r.runningCount }));
    if (parts.length > 0) subs.push(parts.join(' · '));
    const samples = samplesLine(r);
    if (samples !== null) subs.push(samples);
    return { main, subs };
  }
  if (r.status === 'timed_out') {
    if (r.runningCount === 0 && r.extraCount === 0) return null;
    // Tasks that finished during the wait window matter just as much on a
    // timeout as on a completed wait — surface their count too.
    const main =
      r.runningCount > 0
        ? t('tools.waitfor.stillRunning', { count: r.runningCount })
        : t('tools.waitfor.moreFinished', { count: r.extraCount });
    const subs: string[] = [];
    if (r.runningCount > 0 && r.extraCount > 0) {
      subs.push(t('tools.waitfor.moreFinished', { count: r.extraCount }));
    }
    const samples = samplesLine(r);
    if (samples !== null) subs.push(samples);
    return { main, subs };
  }
  return null;
});

const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const canExpand = computed(() => glance.value !== null || hasOutput.value);
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
    <template #leading><Icon name="clock" size="sm" /></template>
    <span class="tl-name">{{ toolLabel(tool.name) }}</span>
    <span v-if="headline" class="tl-dim">{{ headline }}</span>
    <template #trailing>
      <Badge v-if="result?.status === 'timed_out'" variant="warning" size="sm">{{ t('tools.waitfor.timedOut') }}</Badge>
      <Badge v-else-if="result?.status === 'completed' && finishedStatusLabel" :variant="statusBadgeVariant" size="sm">{{ finishedStatusLabel }}</Badge>
      <span v-if="chip" class="tl-chip">{{ chip }}</span>
    </template>
    <template #body>
      <div v-if="glance" class="wf-glance">
        <div class="wf-main">{{ glance.main }}</div>
        <div v-for="(sub, i) in glance.subs" :key="i" class="wf-sub">{{ sub }}</div>
      </div>
      <OutputPanel
        v-if="hasOutput"
        :lines="tool.output"
        :empty-text="status === 'running' ? t('tools.output.waiting') : t('tools.output.empty')"
      />
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.wf-glance {
  margin-bottom: var(--space-1);
}
.wf-main {
  color: var(--color-text);
  font-size: var(--text-sm);
  line-height: var(--leading-prose);
  white-space: pre-wrap;
  word-break: break-word;
}
.wf-sub {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-prose);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
