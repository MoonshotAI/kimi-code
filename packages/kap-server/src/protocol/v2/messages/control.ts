import { z } from 'zod';

export const helloMessageSchema = z.object({
  type: z.literal('hello'),
  protocol_version: z.number(),
  server_id: z.string(),
  capabilities: z.array(z.string()),
});
export type HelloMessage = z.infer<typeof helloMessageSchema>;

export const subscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  id: z.number(),
  session_id: z.string(),
  agent_id: z.string().optional(),
  omit: z.array(z.string()).optional(),
});
export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>;

export const unsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  id: z.number(),
  session_id: z.string(),
});
export type UnsubscribeMessage = z.infer<typeof unsubscribeMessageSchema>;

export const ackMessageSchema = z.object({
  type: z.literal('ack'),
  id: z.number(),
  code: z.number(),
  msg: z.string().optional(),
});
export type AckMessage = z.infer<typeof ackMessageSchema>;

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.union([z.string(), z.number()]),
  msg: z.string().optional(),
});
export type ErrorMessage = z.infer<typeof errorMessageSchema>;

export const clientMessageSchema = z.discriminatedUnion('type', [
  subscribeMessageSchema,
  unsubscribeMessageSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
