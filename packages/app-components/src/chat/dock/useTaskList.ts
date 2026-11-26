import { inject } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TaskItem } from '@moonshot-ai/app-core/client/types';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { ModelDisplayKey, SubagentEffortKey } from '@moonshot-ai/app-client/contracts';
import { formatDuration } from '@moonshot-ai/app-core/lib';

export interface TaskListProps {
  tasks: TaskItem[];
  cancellingTaskIds?: Record<string, true>;
}

export interface TaskListEmits {
  cancel: [taskId: string];
}

export function useTaskList(props: TaskListProps) {
  const { t: translate } = useI18n();
  const t = translate as (key: string, params?: Record<string, unknown> | number, plural?: number) => string;
  const panelApi = inject(panelApiKey, undefined);
  const modelDisplay = inject(ModelDisplayKey, undefined);
  const subagentEffort = inject(SubagentEffortKey, undefined);

  function isCancelling(task: TaskItem): boolean {
    return props.cancellingTaskIds?.[task.id] === true;
  }

  function stateLabel(state: string): string {
    if (state === 'done') return t('tasks.stateDone');
    if (state === 'fail') return t('tasks.stateFail');
    if (state === 'cancelled') return t('tasks.stateCancelled');
    return t('tasks.running');
  }

  function durationLabel(task: TaskItem): string {
    if (typeof task.durationMs !== 'number') return '';
    return formatDuration(task.durationMs, {
      h: t('status.timeUnitHour'),
      m: t('status.timeUnitMinute'),
      s: t('status.timeUnitSecond'),
    });
  }

  return { t, panelApi, modelDisplay, subagentEffort, isCancelling, stateLabel, durationLabel };
}
