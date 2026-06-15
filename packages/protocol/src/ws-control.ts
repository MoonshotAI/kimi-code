/**
 *   Event:   { type, seq, session_id?, timestamp, payload }
 *   Control: { type, id?, payload }
 *   Ack:     { type: 'ack', id, code, msg, payload }
 */
import { z } from 'zod';

import { isoDateTimeSchema } from './time';

export const wsEventEnvelopeSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    type: z.string(),
    seq: z.number().int().nonnegative(),
    session_id: z.string().optional(),
    timestamp: isoDateTimeSchema,
    payload,
  });

export const wsControlEnvelopeSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    type: z.string(),
    id: z.string().optional(),
    payload,
  });

export const wsAckEnvelopeSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    type: z.literal('ack'),
    id: z.string(),
    code: z.number().int(),
    msg: z.string(),
    payload,
  });

export const serverHelloPayloadSchema = z.object({
  ws_connection_id: z.string(),
  heartbeat_ms: z.number().int().positive(),
  max_event_buffer_size: z.number().int().positive(),
  capabilities: z.object({
    event_batching: z.boolean(),
    compression: z.boolean(),
  }),
});

export const serverHelloMessageSchema = z.object({
  type: z.literal('server_hello'),
  timestamp: isoDateTimeSchema,
  payload: serverHelloPayloadSchema,
});

export type ServerHelloMessage = z.infer<typeof serverHelloMessageSchema>;

export const clientHelloPayloadSchema = z.object({
  client_id: z.string(),
  subscriptions: z.array(z.string()),
  last_seq_by_session: z.record(z.string(), z.number().int().nonnegative()).optional(),
});

export const clientHelloMessageSchema = z.object({
  type: z.literal('client_hello'),
  id: z.string(),
  payload: clientHelloPayloadSchema,
});

export type ClientHelloMessage = z.infer<typeof clientHelloMessageSchema>;

export const helloAckPayloadSchema = z.object({
  accepted_subscriptions: z.array(z.string()).optional(),
  accepted: z.array(z.string()).optional(),
  not_found: z.array(z.string()).optional(),
  resync_required: z.array(z.string()),
});

export const watchFsConfigSchema = z.object({
  paths: z.array(z.string()),
  recursive: z.boolean().optional(),
});

export const subscribePayloadSchema = z.object({
  session_ids: z.array(z.string()),
  last_seq_by_session: z.record(z.string(), z.number().int().nonnegative()).optional(),
  watch_fs: z.record(z.string(), watchFsConfigSchema).optional(),
});

export const subscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  id: z.string(),
  payload: subscribePayloadSchema,
});

export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>;

export const unsubscribePayloadSchema = z.object({
  session_ids: z.array(z.string()),
});

export const unsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  id: z.string(),
  payload: unsubscribePayloadSchema,
});

export type UnsubscribeMessage = z.infer<typeof unsubscribeMessageSchema>;

export const watchFsAddPayloadSchema = z.object({
  session_id: z.string(),
  paths: z.array(z.string()),
  recursive: z.boolean().optional(),
});

export const watchFsAddMessageSchema = z.object({
  type: z.literal('watch_fs_add'),
  id: z.string(),
  payload: watchFsAddPayloadSchema,
});

export type WatchFsAddMessage = z.infer<typeof watchFsAddMessageSchema>;

export const watchFsRemovePayloadSchema = z.object({
  session_id: z.string(),
  paths: z.array(z.string()),
});

export const watchFsRemoveMessageSchema = z.object({
  type: z.literal('watch_fs_remove'),
  id: z.string(),
  payload: watchFsRemovePayloadSchema,
});

export type WatchFsRemoveMessage = z.infer<typeof watchFsRemoveMessageSchema>;

export const watchFsAckPayloadSchema = z.object({
  watched_paths: z.array(z.string()).optional(),
  current_count: z.number().int().nonnegative().optional(),
});

export const abortPayloadSchema = z.object({
  session_id: z.string(),
  prompt_id: z.string(),
});

export const abortMessageSchema = z.object({
  type: z.literal('abort'),
  id: z.string(),
  payload: abortPayloadSchema,
});

export type AbortMessage = z.infer<typeof abortMessageSchema>;

export const abortAckPayloadSchema = z.object({
  aborted: z.boolean().optional(),
  at_seq: z.number().int().nonnegative().optional(),
});

export const pingPayloadSchema = z.object({
  nonce: z.string(),
});

export const pingMessageSchema = z.object({
  type: z.literal('ping'),
  timestamp: isoDateTimeSchema,
  payload: pingPayloadSchema,
});

export type PingMessage = z.infer<typeof pingMessageSchema>;

export const pongPayloadSchema = z.object({
  nonce: z.string(),
});

export const pongMessageSchema = z.object({
  type: z.literal('pong'),
  payload: pongPayloadSchema,
});

export type PongMessage = z.infer<typeof pongMessageSchema>;

export const resyncRequiredPayloadSchema = z.object({
  session_id: z.string(),
  reason: z.enum(['buffer_overflow', 'session_recreated']),
  current_seq: z.number().int().nonnegative(),
});

export const resyncRequiredMessageSchema = z.object({
  type: z.literal('resync_required'),
  timestamp: isoDateTimeSchema,
  payload: resyncRequiredPayloadSchema,
});

export type ResyncRequiredMessage = z.infer<typeof resyncRequiredMessageSchema>;

export const wsErrorPayloadSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
  fatal: z.boolean(),
  request_id: z.string().optional(),
  details: z.unknown().optional(),
});

export const wsErrorMessageSchema = z.object({
  type: z.literal('error'),
  timestamp: isoDateTimeSchema,
  payload: wsErrorPayloadSchema,
});

export type WsErrorMessage = z.infer<typeof wsErrorMessageSchema>;

export const clientControlMessageSchema = z.discriminatedUnion('type', [
  clientHelloMessageSchema,
  subscribeMessageSchema,
  unsubscribeMessageSchema,
  watchFsAddMessageSchema,
  watchFsRemoveMessageSchema,
  abortMessageSchema,
  pongMessageSchema,
]);

export type ClientControlMessage = z.infer<typeof clientControlMessageSchema>;

export const serverSystemMessageSchema = z.discriminatedUnion('type', [
  serverHelloMessageSchema,
  pingMessageSchema,
  resyncRequiredMessageSchema,
  wsErrorMessageSchema,
]);

export type ServerSystemMessage = z.infer<typeof serverSystemMessageSchema>;
