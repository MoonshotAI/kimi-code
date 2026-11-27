<script setup lang="ts">
import { useHistoryState } from '../historyState';
import { computed, inject } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, IconButton, Spinner } from '@moonshot-ai/app-ui';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import type { ToolCall } from '@moonshot-ai/app-core/client/types';
import { ResolveAgentModelKey, ResolveAgentTaskIdKey, ResolveAgentTaskStateKey, ResolveDetachableTaskKey } from '@moonshot-ai/app-client/contracts';
import { toolLabel } from '../../lib/toolMeta';
import ToolDisclosure from './ToolDisclosure.vue';
import ToolPanel from './ToolPanel.vue';

const { t } = useI18n();

const props = withDefaults(defineProps<{ tool: ToolCall; mobile?: boolean }>(), { mobile: false });

const emit = defineEmits<{ detach: [toolCallId: string] }>();

const panelApi = inject(panelApiKey);

interface AgentInput {
  description?: string;
  subagentType?: string;
  runInBackground?: boolean;
}

function parseAgentInput(arg: string): AgentInput {
  if (!arg) return {};
  try {
    const obj = JSON.parse(arg) as Record<string, unknown>;
    return {
      description: typeof obj['description'] === 'string' ? obj['description'] : undefined,
      subagentType: typeof obj['subagent_type'] === 'string' ? obj['subagent_type'] : undefined,
      runInBackground: obj['run_in_background'] === true,
    };
  } catch {
    return {};
  }
}

const input = computed(() => parseAgentInput(props.tool.arg));
const status = computed<'running' | 'ok' | 'error'>(() => props.tool.status as 'running' | 'ok' | 'error');

const task = computed(() => input.value.description || input.value.subagentType || toolLabel(props.tool.name));
const agentType = computed(() => (input.value.description ? input.value.subagentType : ''));

const resolveAgentTaskId = inject(ResolveAgentTaskIdKey);
const resolveAgentModel = inject(ResolveAgentModelKey);
const agentTarget = computed(
  () => props.tool.agentId ?? resolveAgentTaskId?.(props.tool.id),
);
const canOpenAgent = computed(() => agentTarget.value !== undefined);
const resolveAgentTaskState = inject(ResolveAgentTaskStateKey);
const taskState = computed(() =>
  input.value.runInBackground
    ? resolveAgentTaskState?.(props.tool.id, agentTarget.value)
    : undefined,
);
const displayStatus = computed<'running' | 'ok' | 'error' | 'cancelled'>(() => {
  const ts = taskState.value;
  if (ts === 'run') return 'running';
  if (ts === 'done') return 'ok';
  if (ts === 'fail') return 'error';
  if (ts === 'cancelled') return 'cancelled';
  return status.value;
});

const boundModel = computed(() => resolveAgentModel?.(props.tool.id, agentTarget.value));
const modelLine = computed(() =>
  [agentType.value, boundModel.value?.display, boundModel.value?.effort]
    .filter((part) => part)
    .join(' · '),
);

const headline = computed(() =>
  input.value.runInBackground ? t('tools.agent.backgroundAgent') : t('tools.agent.foregroundAgent'),
);
const doneCount = computed(() => (displayStatus.value === 'ok' ? 1 : 0));

const expanded = useHistoryState(`tool:${props.tool.id}:expanded`, true);

const resolveDetachableTask = inject(ResolveDetachableTaskKey, undefined);
const canDetach = computed(
  () =>
    input.value.runInBackground !== true &&
    status.value === 'running' &&
    resolveDetachableTask?.(props.tool.id) === true,
);

function onOpenAgent(): void {
  if (agentTarget.value === undefined) return;
  panelApi?.openAgent(agentTarget.value);
}
</script>

<template>
  <ToolDisclosure
    :status="displayStatus"
    :open="expanded"
    expandable
    @toggle="expanded = !expanded"
  >
    <template #leading><Icon name="sparkles" size="sm" /></template>
    <span class="tl-name">{{ headline }}</span>
    <span class="tl-faint">{{ doneCount }} / 1</span>
    <template #trailing>
      <IconButton
        v-if="canDetach"
        class="detach"
        :class="{ touch: mobile }"
        size="sm"
        :label="t('tasks.toBackground')"
        :tooltip="t('tasks.toBackground')"
        @click.stop="emit('detach', tool.id)"
      >
        <Icon name="pip" size="sm" />
      </IconButton>
    </template>
    <template #body>
      <ToolPanel>
        <component
          :is="canOpenAgent ? 'button' : 'div'"
          class="ag-card"
          :class="{ clickable: canOpenAgent }"
          :type="canOpenAgent ? 'button' : undefined"
          :aria-label="canOpenAgent ? t('tasks.openDetail') : undefined"
          @click="onOpenAgent"
        >
          <span class="ag-avatar" aria-hidden="true"><Icon name="robot" size="lg" /></span>
          <span class="ag-text">
            <span class="ag-title">{{ task }}</span>
            <span v-if="modelLine" class="ag-model">{{ modelLine }}</span>
          </span>
          <Spinner v-if="displayStatus === 'running'" size="xs" class="ag-spin" />
        </component>
      </ToolPanel>
    </template>
  </ToolDisclosure>
</template>

<style scoped>
.ag-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  text-align: left;
  font-family: inherit;
  font-size: inherit;
}
.ag-card.clickable {
  cursor: pointer;
}
.ag-card:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}

.ag-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  background: var(--color-fill-1);
  color: var(--color-text);
}

.ag-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
.ag-title {
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ag-card .ag-spin {
  color: var(--color-text);
}
.ag-model {
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detach.touch {
  margin-left: 14px;
}
</style>
