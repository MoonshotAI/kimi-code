<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { TaskItem } from '@moonshot-ai/app-core/client/types';
import { Icon, IconButton, Spinner, StatusDot, Tooltip } from '@moonshot-ai/app-ui';
import { useTaskList, type TaskListEmits, type TaskListProps } from './useTaskList';

const props = defineProps<TaskListProps>();

const emit = defineEmits<TaskListEmits>();

function modelEffortLabel(task: TaskItem): string | undefined {
  const parts = [modelDisplay?.(task.model), subagentEffort?.(task.thinkingEffort)].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

const { t } = useI18n();
function num(task: TaskItem, i: number): string {
  return String((task.swarmIndex ?? i) + 1).padStart(2, '0');
}

function canOpen(task: TaskItem): boolean {
  return Boolean(task.agentId) || Boolean(task.output && task.output.length > 0);
}

const { panelApi, modelDisplay, subagentEffort, isCancelling, stateLabel, durationLabel } = useTaskList(props, t);
</script>

<template>
  <div v-if="tasks.length === 0" class="sg-empty">{{ t('tasks.emptyTasks') }}</div>
  <div v-else class="sg-grid">
    <Tooltip v-for="(task, i) in tasks" :key="task.id" :text="task.name">
    <div
      class="sg-card"
      :class="[`s-${task.state}`, { openable: canOpen(task) }]"
    >
      <button
        v-if="canOpen(task)"
        type="button"
        class="sg-open"
        :aria-label="task.name"
        @click="panelApi?.openAgent(task.agentId ?? task.id)"
      />
      <div class="sg-top">
        <span class="sg-num">{{ num(task, i) }}</span>
        <span class="sg-name">{{ task.name }}</span>
      </div>
      <div v-if="task.meta" class="sg-desc">{{ task.meta }}</div>
      <div class="sg-foot">
        <div v-if="modelEffortLabel(task)" class="sg-model">
          <Icon name="robot" size="sm" /><span>{{ modelEffortLabel(task) }}</span>
        </div>
        <div class="sg-status">
          <span class="sg-state">
            <StatusDot v-if="task.state === 'run'" status="running" />
            <Icon v-else-if="task.state === 'done'" class="sg-ic-done" name="circle-check" size="sm" />
            <Icon v-else-if="task.state === 'cancelled'" class="sg-cancelled" name="stop" size="sm" />
            <Icon v-else name="close" size="sm" />
            {{ stateLabel(task.state) }}
          </span>
          <span v-if="durationLabel(task)" class="sg-time"><Icon name="clock" size="sm" />{{ durationLabel(task) }}</span>
        </div>
      </div>
      <Tooltip v-if="task.state === 'run'" :text="t('tasks.stop')">
        <IconButton
          class="sg-cancel"
          size="sm"
          :label="t('tasks.stop')"
          :disabled="isCancelling(task)"
          @click.stop="emit('cancel', task.id)"
        >
          <Spinner v-if="isCancelling(task)" size="sm" />
          <Icon v-else name="stop" size="sm" />
        </IconButton>
      </Tooltip>
    </div>
    </Tooltip>
  </div>
</template>

<style scoped>
.sg-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-faint);
  font-size: var(--text-sm);
  user-select: none;
}
.sg-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--p-subagent-card-min), 1fr));
  gap: var(--space-2);
}
.sg-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  background: var(--color-selected);
}
.sg-card.openable {
  cursor: pointer;
}
.sg-card.openable:hover {
  background: var(--color-selected-hover);
}
.sg-card:not(.openable) {
  cursor: not-allowed;
}
.sg-open {
  position: absolute;
  inset: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  cursor: pointer;
}
.sg-open:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.sg-top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.sg-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
.sg-num {
  flex: none;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}
.sg-card:has(.sg-cancel) .sg-top {
  padding-right: calc(var(--icon-button-sm) + var(--space-1));
}
@media (hover: none) {
  .sg-card:has(.sg-cancel) .sg-top {
    padding-right: calc(var(--touch-target-min) + var(--space-1));
  }
}
.sg-desc {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-caption);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sg-foot {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.sg-model {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.sg-model span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sg-status {
  display: flex;
  align-items: center;
}
.sg-state {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  text-autospace: normal;
}
.sg-ic-done {
  color: var(--color-success);
  transform: scale(0.91);
}
.sg-cancelled { color: var(--color-text-muted); }
.s-fail .sg-state { color: var(--color-danger); }
.sg-time {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  text-autospace: normal;
}
.sg-cancel {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  color: var(--color-text-muted);
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}
.sg-card:hover .sg-cancel,
.sg-cancel:focus-visible {
  opacity: 1;
}
.sg-cancel:hover:not(:disabled) {
  color: var(--color-danger);
}
@media (hover: none) {
  .sg-cancel {
    top: 0;
    right: 0;
    width: var(--touch-target-min);
    height: var(--touch-target-min);
    opacity: 1;
  }
}
</style>
