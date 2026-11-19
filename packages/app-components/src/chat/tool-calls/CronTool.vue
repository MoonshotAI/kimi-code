<script setup lang="ts">
import { useHistoryState } from '../historyState';
import { computed, inject, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { formatZonedDateTime, humanizeCronSchedule, parseCronCreateResult, parseCronDeleteResult, parseCronListResult, type CronJobFields } from '@moonshot-ai/app-core/lib';
import { normalizeToolName, toolIconName, toolLabel, toolSummary } from '@moonshot-ai/app-components';
import { parseArgRecord, str } from '@moonshot-ai/app-components';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';
import { CronToolContextKey } from './cronToolContext';

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const { t, locale } = useI18n();
const cronContexts = inject(CronToolContextKey, undefined);

const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');
const kind = computed(() => normalizeToolName(props.tool.name));

const args = computed(() => parseArgRecord(props.tool.arg));
const promptArg = computed(() => str(args.value?.prompt) ?? '');

const summary = computed(() => toolSummary(props.tool.name, props.tool.arg));
const summaryFull = computed(() => toolSummary(props.tool.name, props.tool.arg, true));

const ok = computed(() => status.value === 'ok');
const created = computed(() => (ok.value && kind.value === 'croncreate' ? parseCronCreateResult(props.tool.output) : null));
const deleted = computed(() => (ok.value && kind.value === 'crondelete' ? parseCronDeleteResult(props.tool.output) : null));
const list = computed(() => (ok.value && kind.value === 'cronlist' ? parseCronListResult(props.tool.output) : null));

function scheduleText(cron: string | undefined, recurring = true): string {
  return cron ? (humanizeCronSchedule(t, cron, recurring) ?? '') : '';
}

function nextFireText(value: string | undefined): string {
  if (!value || value === 'null') return '—';
  return formatZonedDateTime(locale.value, value);
}

const details = computed(() => {
  const f = deleted.value ? (cronContexts?.value.get(props.tool.id) ?? deleted.value) : created.value;
  if (!f) return [];
  return [
    { key: 'id', value: f.id ?? '', mono: true },
    { key: 'cron', value: f.cron ?? '', mono: true },
    { key: 'schedule', value: scheduleText(f.cron, f.recurring !== 'false'), mono: false },
    { key: 'prompt', value: deleted.value ? f.prompt ?? '' : promptArg.value, mono: false },
    { key: 'recurring', value: f.recurring === undefined ? '' : t(f.recurring === 'false' ? 'tools.cron.recurring.no' : 'tools.cron.recurring.yes'), mono: false },
    { key: 'nextFireAt', value: deleted.value ? '' : nextFireText(f.nextFireAt), mono: false },
  ].filter((row) => row.value !== '');
});

function promptPreview(value: string | undefined): string {
  if (!value) return '';
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

function jobMeta(job: CronJobFields): string {
  const recurring = t(job.recurring === 'false' ? 'tools.cron.recurring.no' : 'tools.cron.recurring.yes');
  return [
    scheduleText(job.cron, job.recurring !== 'false') || job.cron || '',
    recurring,
    nextFireText(job.nextFireAt),
    job.stale === 'true' ? t('conversation.cron.finalDelivery') : '',
  ]
    .filter((part) => part !== '')
    .join(' · ');
}

const parsed = computed(() => created.value !== null || deleted.value !== null || list.value !== null);
const hasOutput = computed(() => !!props.tool.output && props.tool.output.length > 0);
const showArgs = computed(
  () => !parsed.value && summaryFull.value !== '' && summaryFull.value !== summary.value,
);
const canExpand = computed(
  () => details.value.length > 0 || list.value !== null || showArgs.value || (!parsed.value && hasOutput.value),
);
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
    <template #leading><Icon :name="toolIconName(tool.name)" size="sm" /></template>
    <span class="tl-name">{{ toolLabel(tool.name, tool.arg) }}</span>
    <span v-if="summary" class="tl-dim">{{ summary }}</span>
    <template #body>
      <ToolPanel scroll>
        <dl v-if="details.length > 0" class="cron-fields">
          <template v-for="row in details" :key="row.key">
            <dt>{{ t(`tools.cron.field.${row.key}`) }}</dt>
            <dd :class="{ mono: row.mono }">{{ row.value }}</dd>
          </template>
        </dl>
        <div v-else-if="list" class="cron-list">
          <div v-if="list.jobs.length === 0" class="cron-note">{{ t('tools.cron.none') }}</div>
          <div v-for="job in list.jobs" :key="job.id" class="cron-job">
            <span class="cron-desc">{{ promptPreview(job.prompt) || job.id }}</span>
            <span class="cron-meta"><span class="mono">{{ job.id }}</span>{{ jobMeta(job) === '' ? '' : ` · ${jobMeta(job)}` }}</span>
          </div>
        </div>
        <div v-if="showArgs" class="cron-args">{{ summaryFull }}</div>
        <OutputPanel v-if="!parsed && hasOutput" :lines="tool.output" />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.cron-fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--space-1) var(--space-3);
  margin: 0;
  font-size: var(--text-base);
  line-height: 20px;
}
.cron-fields dt {
  color: var(--color-text-faint);
}
.cron-fields dd {
  margin: 0;
  min-width: 0;
  color: var(--color-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cron-fields dd.mono {
  font-family: var(--font-mono);
}
.cron-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.cron-job {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: var(--text-base);
  line-height: 20px;
}
.cron-desc {
  min-width: 0;
  color: var(--color-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cron-meta {
  color: var(--color-text-faint);
  overflow-wrap: anywhere;
}
.cron-meta .mono {
  font-family: var(--font-mono);
}
.cron-note {
  color: var(--color-text-faint);
  font-size: var(--text-base);
  line-height: 20px;
}
.cron-args {
  margin-bottom: var(--space-2);
  color: var(--color-text-muted);
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
