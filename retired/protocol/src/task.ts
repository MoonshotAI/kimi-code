import { z } from 'zod';

import { isoDateTimeSchema } from './time';

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

// Backward-compatible aliases for the legacy `BackgroundTask` naming. The
// pre-v2 agent core (`packages/agent-core`), the SDK, and the TUI still import
// these names from the protocol, while the v2 engine and the protocol itself
// have moved to the `Task`/`TaskKind`/`TaskStatus` spelling. New code should
// prefer the `Task*` names.
export type BackgroundTaskKind = TaskKind;
export type BackgroundTaskStatus = TaskStatus;
export type BackgroundTask = Task;
