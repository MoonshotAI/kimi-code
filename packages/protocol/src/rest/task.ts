/**
 *   GET  /v1/sessions/{session_id}/tasks                 query: {status?}
 *     Response data: `{ items: BackgroundTask[] }`
 *
 *   GET  /v1/sessions/{session_id}/tasks/{task_id}       query: {with_output?, output_bytes?}
 *     Response data: `BackgroundTask`
 *     Errors: 40406 (task.not_found)
 *
 *   POST /v1/sessions/{session_id}/tasks/{task_id}:cancel
 *     Body: empty
 *     Response data: `{ cancelled: true }`
 *     Errors: 40406 (task.not_found), 40904 (task.already_finished)
 */

import { z } from 'zod';

import { backgroundTaskSchema, backgroundTaskStatusSchema } from '../task';

export const listTasksQuerySchema = z.object({
  status: backgroundTaskStatusSchema.optional(),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const listTasksResponseSchema = z.object({
  items: z.array(backgroundTaskSchema),
});
export type ListTasksResponse = z.infer<typeof listTasksResponseSchema>;

export const getTaskQuerySchema = z.object({
  with_output: z.coerce.boolean().optional(),
  output_bytes: z.coerce.number().int().nonnegative().optional(),
});
export type GetTaskQuery = z.infer<typeof getTaskQuerySchema>;

export const getTaskResponseSchema = backgroundTaskSchema;
export type GetTaskResponse = z.infer<typeof getTaskResponseSchema>;

export const cancelTaskResultSchema = z.object({
  cancelled: z.literal(true),
});
export type CancelTaskResult = z.infer<typeof cancelTaskResultSchema>;

export const taskAlreadyFinishedDataSchema = z.object({
  cancelled: z.literal(false),
});
export type TaskAlreadyFinishedData = z.infer<typeof taskAlreadyFinishedDataSchema>;
