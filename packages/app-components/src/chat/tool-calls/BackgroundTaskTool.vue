<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@moonshot-ai/app-ui';
import {
  parseTaskListResult,
  parseTaskOutputResult,
  parseTaskStopResult,
  type TaskFields,
} from '@moonshot-ai/app-core/lib';
import { str } from '@moonshot-ai/app-components';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';
import OutputPanel from './OutputPanel.vue';
import { useToolCard, useToolCardExpansion, type ToolCardProps } from './useToolCard';

const props = withDefaults(defineProps<ToolCardProps>(), { mobile: false });
const glyph = computed(() => {
  if (kind.value === 'tasklist') return 'list';
  return kind.value === 'taskstop' ? 'stop' : 'file-text';
});

const taskId = computed(() => str(args.value?.task_id) ?? '');
const activeOnly = computed(() => args.value?.active_only !== false);

const ok = computed(() => status.value === 'ok');
const list = computed(() => (ok.value && kind.value === 'tasklist' ? parseTaskListResult(props.tool.output) : null));
const read = computed(() => (ok.value && kind.value === 'taskoutput' ? parseTaskOutputResult(props.tool.output) : null));
const stop = computed(() => (ok.value && kind.value === 'taskstop' ? parseTaskStopResult(props.tool.output) : null));
const fields = computed<TaskFields | null>(() => read.value?.fields ?? stop.value);

function translated(key: string, fallback: string): string {
  return te(key) ? t(key) : fallback;
}
function statusText(value: string | undefined): string {
  return value ? translated(`tools.bgTask.status.${value}`, value) : '';
}
function kindText(value: string | undefined): string {
  return value ? translated(`tools.bgTask.kind.${value}`, value) : '';
}

const subject = computed(() => {
  if (kind.value === 'tasklist') return t(activeOnly.value ? 'tools.bgTask.active' : 'tools.bgTask.all');
  return fields.value?.description || taskId.value;
});

const chip = computed(() => {
  if (list.value) return list.value.count > 0 ? t('tools.bgTask.count', { count: list.value.count }) : t('tools.bgTask.none');
  return statusText(fields.value?.status);
});

const DETAIL_FIELDS = ['status', 'kind', 'command', 'pid', 'exit_code', 'subagent_type', 'model', 'reason', 'stop_reason', 'output_path'];

const details = computed(() => {
  const f = fields.value;
  if (!f) return [];
  return DETAIL_FIELDS.filter((key) => f[key]).map((key) => ({
    key,
    label: t(`tools.bgTask.field.${key}`),
    value: key === 'status' ? statusText(f[key]) : key === 'kind' ? kindText(f[key]) : f[key]!,
    mono: key === 'command' || key === 'output_path',
  }));
});

const parsed = computed(() => list.value !== null || fields.value !== null);
const { t, te, status, kind, args, hasOutput, toolLabel } = useToolCard(props);
const canExpand = computed(() => (list.value?.tasks.length ?? 0) > 0 || details.value.length > 0 || hasOutput.value);
const { open } = useToolCardExpansion(props, canExpand);
</script>

<template>
  <ToolDisclosure :status="status" :open="open" :expandable="canExpand" @toggle="open = !open">
    <template #leading><Icon :name="glyph" size="sm" /></template>
    <span class="tl-name">{{ toolLabel(tool.name) }}</span>
    <span v-if="subject" class="tl-dim">{{ subject }}</span>
    <span v-if="chip" class="tl-faint">{{ chip }}</span>
    <template #body>
      <ToolPanel scroll>
        <div v-if="list && list.tasks.length > 0" class="bt-list">
          <div v-for="task in list.tasks" :key="task.task_id" class="bt-task">
            <span class="bt-desc">{{ task.description || task.task_id }}</span>
            <span class="bt-meta">{{ [kindText(task.kind), statusText(task.status)].filter((part) => part).join(' · ') }}</span>
          </div>
        </div>
        <dl v-else-if="details.length > 0" class="bt-fields">
          <template v-for="row in details" :key="row.key">
            <dt>{{ row.label }}</dt>
            <dd :class="{ mono: row.mono }">{{ row.value }}</dd>
          </template>
        </dl>
        <div v-if="read?.truncated" class="bt-note">{{ t('tools.bgTask.truncated') }}</div>
        <OutputPanel
          v-if="read"
          :lines="read.output"
          :empty-text="t('tools.output.empty')"
        />
        <OutputPanel v-else-if="!parsed && hasOutput" :lines="tool.output" />
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.bt-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.bt-task {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-base);
  line-height: 20px;
}
.bt-desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}
.bt-meta {
  flex: none;
  color: var(--color-text-faint);
}

.bt-fields {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--space-1) var(--space-3);
  margin: 0;
  font-size: var(--text-base);
  line-height: 20px;
}
.bt-fields dt {
  color: var(--color-text-faint);
}
.bt-fields dd {
  margin: 0;
  min-width: 0;
  color: var(--color-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.bt-fields dd.mono {
  font-family: var(--font-mono);
}
.bt-note {
  color: var(--color-text-faint);
  font-size: var(--text-base);
  line-height: 20px;
}
</style>
