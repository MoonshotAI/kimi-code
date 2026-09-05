import { z } from 'zod';
import { timelineBaseFields } from './base';

export const todoItemSchema = z.object({
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'done']),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

export const todoMessageSchema = z.object({
  type: z.literal('todo'),
  ...timelineBaseFields,
  todo_id: z.string(),
  items: z.array(todoItemSchema),
  updated_at: z.string().optional(),
});
export type TodoMessage = z.infer<typeof todoMessageSchema>;
