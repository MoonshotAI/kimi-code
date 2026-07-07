import { z } from 'zod';

import { isoDateTimeSchema } from './time';

export const backgroundTaskKindSchema = z.enum(['subagent', 'bash', 'tool']);
export type BackgroundTaskKind = z.infer<typeof backgroundTaskKindSchema>;

export const backgroundTaskStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type BackgroundTaskStatus = z.infer<typeof backgroundTaskStatusSchema>;

export const backgroundTaskSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  kind: backgroundTaskKindSchema,
  description: z.string(),
  status: backgroundTaskStatusSchema,
  command: z.string().optional(),
  created_at: isoDateTimeSchema,
  started_at: isoDateTimeSchema.optional(),
  completed_at: isoDateTimeSchema.optional(),
  output_preview: z.string().optional(),
  output_bytes: z.number().int().nonnegative().optional(),
});
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>;
