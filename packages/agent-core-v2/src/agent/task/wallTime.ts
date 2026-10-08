export interface AgentTaskTiming {
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export function formatTaskWallTime(task: AgentTaskTiming): string {
  const durationMs = Math.max(0, (task.endedAt ?? Date.now()) - task.startedAt);
  return `${(durationMs / 1000).toFixed(3)} seconds`;
}
