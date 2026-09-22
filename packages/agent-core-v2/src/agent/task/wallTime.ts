import { monoNowMs } from '#/_base/utils/monotonic';

export interface AgentTaskTiming {
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly monoStartedAt?: number;
  readonly monoEndedAt?: number | null;
}

export function formatTaskWallTime(task: AgentTaskTiming): string {
  const durationMs =
    task.monoStartedAt !== undefined
      ? Math.max(0, (task.monoEndedAt ?? monoNowMs()) - task.monoStartedAt)
      : Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt);
  return `${(durationMs / 1000).toFixed(3)} seconds`;
}
