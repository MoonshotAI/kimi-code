import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

export const taskKindSchema = z.enum(['subagent', 'bash', 'tool']);
export type TaskKind = z.infer<typeof taskKindSchema>;

export const taskStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  kind: taskKindSchema,
  description: z.string(),
  status: taskStatusSchema,
  command: z.string().optional(),
  created_at: isoDateTimeSchema,
  started_at: isoDateTimeSchema.optional(),
  completed_at: isoDateTimeSchema.optional(),
  output_preview: z.string().optional(),
  output_bytes: z.number().int().nonnegative().optional(),
});
export type Task = z.infer<typeof taskSchema>;
