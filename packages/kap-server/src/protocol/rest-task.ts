/**
 *   GET  /v1/sessions/{session_id}/tasks                 query: {status?}
 *   GET  /v1/sessions/{session_id}/tasks/{task_id}       query: {with_output?, output_bytes?}
 *   POST /v1/sessions/{session_id}/tasks/{task_id}:cancel
 */

import { z } from 'zod';

import { taskSchema, taskStatusSchema } from './task';

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

export const taskAlreadyFinishedDataSchema = z.object({
  cancelled: z.literal(false),
});
export type TaskAlreadyFinishedData = z.infer<typeof taskAlreadyFinishedDataSchema>;
