import { z } from 'zod';

import { isoDateTimeSchema, timelineMessageBase } from './base';

export const todoItemSchema = z.object({
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'done']),
});

export type TodoItem = z.infer<typeof todoItemSchema>;

export const todoMessageSchema = z.object({
  type: z.literal('todo'),
  ...timelineMessageBase,
  todo_id: z.string().min(1),
  items: z.array(todoItemSchema),
  updated_at: isoDateTimeSchema.optional(),
});

export type TodoMessage = z.infer<typeof todoMessageSchema>;
