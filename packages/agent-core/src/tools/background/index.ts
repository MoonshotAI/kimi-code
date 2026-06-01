/**
 * Background task management tools barrel.
 */

export { BackgroundProcessManager, generateTaskId } from './manager';
export type {
  AgentBackgroundTaskInfo,
  BackgroundTaskInfo,
  BackgroundTaskKind,
  BackgroundTaskOutputSnapshot,
  BackgroundTaskStatus,
  ProcessBackgroundTaskInfo,
  ReconcileResult,
} from './manager';
export { AgentBackgroundTask } from './agent-task';
export { ProcessBackgroundTask } from './process-task';
export { VALID_TASK_ID } from './persist';
export { TaskListTool, TaskListInputSchema } from './task-list';
export type { TaskListInput } from './task-list';
export { TaskOutputTool, TaskOutputInputSchema } from './task-output';
export type { TaskOutputInput } from './task-output';
export { TaskStopTool, TaskStopInputSchema } from './task-stop';
export type { TaskStopInput } from './task-stop';
