import { z } from 'zod';

import { assistantMessageSchema } from './assistant';
import { interactionMessageSchema } from './interaction';
import { stepMessageSchema } from './step';
import { systemMessageSchema } from './system';
import { taskMessageSchema } from './task';
import { thinkingMessageSchema } from './thinking';
import { todoMessageSchema } from './todo';
import { toolCallMessageSchema } from './tool-call';
import { turnMessageSchema } from './turn';
import { userMessageSchema } from './user';

export const historyMessageSchema = z.discriminatedUnion('type', [
  turnMessageSchema,
  stepMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  thinkingMessageSchema,
  toolCallMessageSchema,
  systemMessageSchema,
  interactionMessageSchema,
  taskMessageSchema,
  todoMessageSchema,
]);

export type HistoryMessage = z.infer<typeof historyMessageSchema>;

export const historyQuerySchema = z.object({
  before_turn: z.string().min(1).optional(),
  after_step: z.string().min(1).optional(),
  page_size: z.number().int().positive().optional(),
  agent_id: z.string().min(1).optional(),
});

export type HistoryQuery = z.infer<typeof historyQuerySchema>;

export const historyInFlightSchema = z.object({
  turn_id: z.string().min(1),
  step_id: z.string().min(1),
});

export type HistoryInFlight = z.infer<typeof historyInFlightSchema>;

export const historyResponseSchema = z.object({
  messages: z.array(historyMessageSchema),
  has_more: z.boolean(),
  in_flight: historyInFlightSchema.optional(),
});

export type HistoryResponse = z.infer<typeof historyResponseSchema>;
