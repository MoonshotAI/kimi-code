/**
 * `/api/v2` WebSocket protocol — message shapes and validators.
 *
 * A single WS connection multiplexes RPC `call`s and event `listen`s over a
 * JSON message protocol. Every request carries a client-chosen `id`; the server
 * correlates responses / events by that id. This is the lean counterpart of
 * VSCode's framed `IMessagePassingProtocol`, carrying the same safety features
 * (request ids, cancellation, schema validation, cleanup). There is no
 * heartbeat: the server never pings and never terminates an idle connection.
 */

import { z } from 'zod';

const scopeKindSchema = z.enum(['core', 'session', 'agent']);

const helloMessageSchema = z.object({
  type: z.literal('hello'),
  token: z.string().optional(),
});

const callMessageSchema = z.object({
  type: z.literal('call'),
  id: z.string().min(1),
  scope: scopeKindSchema,
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  service: z.string().min(1),
  method: z.string().min(1),
  arg: z.unknown().optional(),
});

const cancelMessageSchema = z.object({
  type: z.literal('cancel'),
  id: z.string().min(1),
});

const listenMessageSchema = z.object({
  type: z.literal('listen'),
  id: z.string().min(1),
  scope: scopeKindSchema,
  sessionId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  service: z.string().min(1).optional(),
  event: z.string().min(1),
});

const eventResultMessageSchema = z.object({
  type: z.literal('event_result'),
  id: z.string().min(1),
  eventId: z.string().min(1),
});

const unlistenMessageSchema = z.object({
  type: z.literal('unlisten'),
  id: z.string().min(1),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  helloMessageSchema,
  callMessageSchema,
  cancelMessageSchema,
  listenMessageSchema,
  eventResultMessageSchema,
  unlistenMessageSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type CallMessage = z.infer<typeof callMessageSchema>;
export type ListenMessage = z.infer<typeof listenMessageSchema>;

// Server → client messages (built directly; not validated).

export interface ReadyMessage {
  readonly type: 'ready';
}

export interface ResultMessage {
  readonly type: 'result';
  readonly id: string;
  readonly data: unknown;
}

export interface ErrorMessage {
  readonly type: 'error';
  readonly id: string;
  readonly code: number;
  readonly msg: string;
}

export interface ListenResultMessage {
  readonly type: 'listen_result';
  readonly id: string;
}

export interface EventMessage {
  readonly type: 'event';
  readonly id: string;
  readonly eventId?: string;
  readonly data: unknown;
}

export interface EventCancelMessage {
  readonly type: 'event_cancel';
  readonly id: string;
  readonly eventId: string;
}

export type ServerMessage =
  | ReadyMessage
  | ResultMessage
  | ErrorMessage
  | ListenResultMessage
  | EventMessage
  | EventCancelMessage;
