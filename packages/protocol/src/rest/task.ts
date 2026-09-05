/**
 *   GET  /v1/sessions/{session_id}/tasks                 query: {status?}
 *     Response data: `{ items: Task[] }`
 *
 *   GET  /v1/sessions/{session_id}/tasks/{task_id}       query: {with_output?, output_bytes?}
 *     Response data: `Task`
 *     Errors: 40406 (task.not_found)
 *
 *   POST /v1/sessions/{session_id}/tasks/{task_id}:cancel
 *     Body: empty
 *     Response data: `{ cancelled: true }`
 *     Errors: 40406 (task.not_found), 40904 (task.already_finished)
 *
 *   POST /v1/sessions/{session_id}/tasks/{task_id}:detach
 *     Body: empty
 *     Response data: `{ detached: boolean, status: TaskStatus }`
 *     (`detached: true` only when the call converted a running foreground
 *     task; already-background or terminal tasks answer `detached: false`
 *     with their current status)
 *     Errors: 40406 (task.not_found)
 */

import { z } from 'zod';

import { taskSchema, taskStatusSchema } from '../task';

export const listTasksQuerySchema = z.object({
  status: taskStatusSchema.optional(),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const listTasksResponseSchema = z.object({
  items: z.array(taskSchema),
});
export type ListTasksResponse = z.infer<typeof listTasksResponseSchema>;

export const getTaskQuerySchema = z.object({
  with_output: z.coerce.boolean().optional(),
  output_bytes: z.coerce.number().int().nonnegative().optional(),
});
export type GetTaskQuery = z.infer<typeof getTaskQuerySchema>;

export const getTaskResponseSchema = taskSchema;
export type GetTaskResponse = z.infer<typeof getTaskResponseSchema>;

export const cancelTaskResultSchema = z.object({
  cancelled: z.literal(true),
});
export type CancelTaskResult = z.infer<typeof cancelTaskResultSchema>;

export const detachTaskResultSchema = z.object({
  detached: z.boolean(),
  status: taskStatusSchema,
});
export type DetachTaskResult = z.infer<typeof detachTaskResultSchema>;

export const taskAlreadyFinishedDataSchema = z.object({
  cancelled: z.literal(false),
});
export type TaskAlreadyFinishedData = z.infer<typeof taskAlreadyFinishedDataSchema>;
