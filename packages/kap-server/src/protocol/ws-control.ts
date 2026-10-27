import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';
import { transcriptGradeSpecSchema, transcriptSeqSchema } from '@moonshot-ai/transcript';

import { pushEventSchema } from './events-zod';
import { interactionEventMessageSchema } from './interaction';

export const WS_PROTOCOL_VERSION = 2;

export const wsEventEnvelopeSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    type: z.string(),
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
  protocol_version: z.number().int().positive(),
  heartbeat_ms: z.number().int().positive().optional(),
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
});

export const clientHelloMessageSchema = z.object({
  type: z.literal('client_hello'),
  id: z.string(),
  payload: clientHelloPayloadSchema,
});

export type ClientHelloMessage = z.infer<typeof clientHelloMessageSchema>;

export const clientHelloAckPayloadSchema = z.object({});

export const clientHelloAckMessageSchema = wsAckEnvelopeSchema(clientHelloAckPayloadSchema);

export const subscribeV2PayloadSchema = z.object({
  session_id: z.string().min(1),
  transcript: transcriptGradeSpecSchema,
  transcript_since: z.record(z.string(), transcriptSeqSchema).optional(),
});

export const subscribeV2MessageSchema = z.object({
  type: z.literal('subscribe_v2'),
  id: z.string(),
  payload: subscribeV2PayloadSchema,
});

export type SubscribeV2Message = z.infer<typeof subscribeV2MessageSchema>;

export const unsubscribeV2PayloadSchema = z.object({
  session_id: z.string().min(1),
  agent_ids: z.array(z.string().min(1)).min(1).optional(),
});

export const unsubscribeV2MessageSchema = z.object({
  type: z.literal('unsubscribe_v2'),
  id: z.string(),
  payload: unsubscribeV2PayloadSchema,
});

export type UnsubscribeV2Message = z.infer<typeof unsubscribeV2MessageSchema>;

export const subscribeAckPayloadSchema = z.object({
  accepted: z.array(z.string()),
  not_found: z.array(z.string()),
});

export const subscribeV2AckMessageSchema = wsAckEnvelopeSchema(subscribeAckPayloadSchema);

export const unsubscribeV2AckMessageSchema = wsAckEnvelopeSchema(subscribeAckPayloadSchema);

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
});

export const abortAckMessageSchema = wsAckEnvelopeSchema(abortAckPayloadSchema);

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

export const sessionEventMessageSchema = wsEventEnvelopeSchema(pushEventSchema);

export const clientControlMessageSchema = z.discriminatedUnion('type', [
  clientHelloMessageSchema,
  subscribeV2MessageSchema,
  unsubscribeV2MessageSchema,
  abortMessageSchema,
  pongMessageSchema,
]);

export type ClientControlMessage = z.infer<typeof clientControlMessageSchema>;

export const serverSystemMessageSchema = z.discriminatedUnion('type', [
  serverHelloMessageSchema,
  pingMessageSchema,
  wsErrorMessageSchema,
]);

export type ServerSystemMessage = z.infer<typeof serverSystemMessageSchema>;

export type WsOperationDirection = 'client_to_server' | 'server_to_client';

export type WsOperationKind = 'control' | 'system' | 'event';

export interface WsOperationDefinition {
  readonly type: string;
  readonly direction: WsOperationDirection;
  readonly kind: WsOperationKind;
  readonly messageSchema: z.ZodTypeAny;
  readonly ackSchema?: z.ZodTypeAny;
  readonly description: string;
}

export const clientControlOperations = [
  {
    type: 'client_hello',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: clientHelloMessageSchema,
    ackSchema: clientHelloAckMessageSchema,
    description: 'Start a client session; global push events flow once the socket is open.',
  },
  {
    type: 'subscribe_v2',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: subscribeV2MessageSchema,
    ackSchema: subscribeV2AckMessageSchema,
    description:
      "Attach or update this connection's per-agent transcript grade stream for one session.",
  },
  {
    type: 'unsubscribe_v2',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: unsubscribeV2MessageSchema,
    ackSchema: unsubscribeV2AckMessageSchema,
    description:
      "Detach this connection's transcript grade stream for one session, optionally per agent.",
  },
  {
    type: 'abort',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: abortMessageSchema,
    ackSchema: abortAckMessageSchema,
    description: 'Abort a running prompt in a session.',
  },
  {
    type: 'pong',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: pongMessageSchema,
    description: 'Reply to a server ping with the same nonce.',
  },
] as const satisfies readonly WsOperationDefinition[];

export const serverSystemOperations = [
  {
    type: 'server_hello',
    direction: 'server_to_client',
    kind: 'system',
    messageSchema: serverHelloMessageSchema,
    description: 'Initial server greeting sent immediately after the socket opens.',
  },
  {
    type: 'ping',
    direction: 'server_to_client',
    kind: 'system',
    messageSchema: pingMessageSchema,
    description: 'Heartbeat ping sent by the server; clients must answer with pong.',
  },
  {
    type: 'error',
    direction: 'server_to_client',
    kind: 'system',
    messageSchema: wsErrorMessageSchema,
    description: 'Server-side WebSocket protocol or runtime error.',
  },
] as const satisfies readonly WsOperationDefinition[];

export const sessionEventOperation = {
  type: 'session_event',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: sessionEventMessageSchema,
  description:
    'Global push event envelope sent to every connection; frame type is the payload event type.',
} as const satisfies WsOperationDefinition;

export const interactionEventOperation = {
  type: 'interaction',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: interactionEventMessageSchema,
  description:
    'Flat, unsequenced approval or question state for a subscribed session; pending interactions are re-sent after every accepted subscription.',
} as const satisfies WsOperationDefinition;

export const wsOperations = [
  ...clientControlOperations,
  ...serverSystemOperations,
  sessionEventOperation,
  interactionEventOperation,
] as const satisfies readonly WsOperationDefinition[];

export function getClientControlOperation(
  type: string,
): (typeof clientControlOperations)[number] | undefined {
  return clientControlOperations.find((operation) => operation.type === type);
}
