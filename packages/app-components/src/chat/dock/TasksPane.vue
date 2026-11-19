<script setup lang="ts">
import { inject } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TaskItem } from '@moonshot-ai/app-core/client/types';
import { Icon, IconButton, Spinner, StatusDot, Tooltip } from '@moonshot-ai/app-ui';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { ModelDisplayKey, SubagentEffortKey } from '@moonshot-ai/app-client/contracts';
import { formatDuration } from '@moonshot-ai/app-components';

const props = defineProps<{ tasks: TaskItem[]; cancellingTaskIds?: Record<string, true> }>();

const emit = defineEmits<{
  cancel: [taskId: string];
}>();

const { t } = useI18n();

const panelApi = inject(panelApiKey);

function isCancelling(task: TaskItem): boolean {
  return props.cancellingTaskIds?.[task.id] === true;
}

function hasDetail(task: TaskItem): boolean {
  return Boolean((task.output && task.output.length > 0) || task.meta);
}

function handleClick(task: TaskItem): void {
  if (!isClickable(task)) return;
  panelApi?.openAgent(task.agentId ?? task.id);
}

function isClickable(task: TaskItem): boolean {
  return task.kind === 'subagent' || task.kind === 'tool' || hasDetail(task);
}

function durationLabel(task: TaskItem): string {
  if (typeof task.durationMs !== 'number') return '';
  return formatDuration(task.durationMs, {
    h: t('status.timeUnitHour'),
    m: t('status.timeUnitMinute'),
    s: t('status.timeUnitSecond'),
  });
}

function stateLabel(task: TaskItem): string {
  if (task.state === 'done') return t('tasks.stateDone');
  if (task.state === 'fail') return t('tasks.stateFail');
  if (task.state === 'cancelled') return t('tasks.stateCancelled');
  return t('tasks.running');
}

const modelDisplay = inject(ModelDisplayKey);
const subagentEffort = inject(SubagentEffortKey);
function taskModel(task: TaskItem): string | undefined {
  if (task.kind !== 'subagent') return undefined;
  return modelDisplay?.(task.model);
}
function taskEffort(task: TaskItem): string | undefined {
  if (task.kind !== 'subagent') return undefined;
  return subagentEffort?.(task.thinkingEffort);
}
</script>

<template>
  <div class="taskspane">
    <div class="tp-list">
      <div v-if="tasks.length === 0" class="tp-empty">{{ t('tasks.emptyTasks') }}</div>

      <template v-else>
        <Tooltip v-for="task in tasks" :key="task.id" :text="task.name">
        <div
          class="tp-row"
          :class="{ fail: task.state === 'fail', expandable: isClickable(task) }"
        >
          <div class="tp-main">
            <button
              v-if="isClickable(task)"
              type="button"
              class="tp-open"
              :aria-label="task.name"
              @click="handleClick(task)"
            />
            <span class="tp-glyph" role="img" :aria-label="stateLabel(task)">
              <StatusDot v-if="task.state === 'run'" status="running" />
              <Icon v-else-if="task.state === 'done'" class="tp-done" name="circle-check" size="sm" />
              <Icon v-else-if="task.state === 'cancelled'" class="tp-cancelled" name="stop" size="sm" />
              <Icon v-else class="tp-fail" name="close" size="sm" />
            </span>
            <span class="tp-name">{{ task.name }}</span>
            <span v-if="task.meta" class="tp-meta">{{ task.meta }}</span>
            <span v-if="taskModel(task)" class="tp-model">{{ taskModel(task) }}</span>
            <span v-if="taskEffort(task)" class="tp-model">{{ taskEffort(task) }}</span>
            <span v-if="durationLabel(task)" class="tp-time">{{ durationLabel(task) }}</span>
            <Tooltip v-if="task.state === 'run'" :text="t('tasks.stop')">
              <IconButton
                class="tp-stop"
                size="sm"
                :label="t('tasks.stop')"
                :disabled="isCancelling(task)"
                @click.stop="emit('cancel', task.id)"
              >
                <Spinner v-if="isCancelling(task)" size="sm" />
                <Icon v-else name="stop" size="sm" />
              </IconButton>
            </Tooltip>
            <Icon v-if="isClickable(task)" class="tp-chevron" name="chevron-right" size="sm" />
          </div>
        </div>
        </Tooltip>
      </template>
    </div>
  </div>
</template>

<style scoped>
.taskspane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.tp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-05);
}

.tp-row {
  padding: var(--space-1) 0;
}
.tp-row.fail .tp-name {
  color: var(--color-danger);
}

.tp-main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-base);
}
.tp-row.expandable > .tp-main {
  position: relative;
  border-radius: var(--radius-lg);
  padding: var(--space-1) var(--space-2);
  margin: calc(-1 * var(--space-1)) 0;
}
.tp-row.expandable > .tp-main:hover {
  background: var(--color-hover);
}
.tp-row:not(.expandable) {
  cursor: not-allowed;
}
.tp-open {
  position: absolute;
  inset: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  cursor: pointer;
}
.tp-open:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.tp-chevron {
  flex: none;
  color: var(--muted);
}

.tp-name {
  color: var(--color-text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tp-meta {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
}

.tp-glyph {
  flex: none;
  width: var(--p-ic-md);
  height: var(--p-ic-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tp-done {
  color: var(--color-success);
  transform: scale(0.91);
}
.tp-cancelled { color: var(--color-text-muted); }
.tp-fail { color: var(--color-danger); }

.tp-time {
  flex: none;
  font-size: var(--text-base);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  text-autospace: normal;
}

.tp-model {
  flex: 0 1 auto;
  min-width: 0;
  font-size: var(--text-base);
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-stop {
  position: relative;
  flex: none;
  color: var(--color-text-muted);
}
.tp-stop:hover:not(:disabled) { color: var(--color-danger); }
@media (hover: none) {
  .tp-stop {
    width: var(--touch-target-min);
    height: var(--touch-target-min);
  }
  .tp-row.expandable > .tp-main {
    min-height: var(--touch-target-min);
  }
}

.tp-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--faint);
  font-size: var(--ui-font-size-sm);
  user-select: none;
}

@media (max-width: 640px) {
  .tp-main { flex-wrap: wrap; row-gap: var(--space-1); }
  .tp-name { font-size: var(--ui-font-size-sm); }
  .tp-meta {
    order: 10;
    flex: 1 1 100%;
    padding-left: calc(var(--p-ic-md) + var(--space-2));
    font-size: var(--ui-font-size-xs);
  }
}
</style>
