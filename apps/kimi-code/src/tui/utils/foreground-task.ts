import type { BackgroundTaskInfo } from '@moonshot-ai/kimi-code-sdk';

function isDetachableForegroundTask(t: BackgroundTaskInfo): boolean {
  return (
    t.detached === false &&
    t.status === 'running' &&
    (t.kind === 'process' || t.kind === 'agent')
  );
}

/**
 * Pick all foreground tasks that `Ctrl+B` should detach: `detached === false`,
 * currently-running Bash (`process`) or subagent (`agent`) tasks, most recently
 * started first.
 */
export function pickForegroundTasks(
  tasks: readonly BackgroundTaskInfo[],
): BackgroundTaskInfo[] {
  return tasks
    .filter(isDetachableForegroundTask)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Pick the single most recently started foreground task. Kept for callers that
 * only need one; `Ctrl+B` uses {@link pickForegroundTasks} to detach them all.
 */
export function pickForegroundTask(
  tasks: readonly BackgroundTaskInfo[],
): BackgroundTaskInfo | undefined {
  return pickForegroundTasks(tasks)[0];
}
