import type { BackgroundTaskInfo } from '@moonshot-ai/kimi-code-sdk';

function isDetachableForegroundTask(t: BackgroundTaskInfo): boolean {
  return (
    t.detached === false &&
    t.status === 'running' &&
    (t.kind === 'process' || t.kind === 'agent')
  );
}

export function pickForegroundTasks(
  tasks: readonly BackgroundTaskInfo[],
): BackgroundTaskInfo[] {
  return tasks
    .filter(isDetachableForegroundTask)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function pickForegroundTask(
  tasks: readonly BackgroundTaskInfo[],
): BackgroundTaskInfo | undefined {
  return pickForegroundTasks(tasks)[0];
}
