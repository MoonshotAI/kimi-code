import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

import {
  itemDeltaMessageSchema,
  itemMessageSchema,
  itemRemovedMessageSchema,
  itemUpdatedMessageSchema,
  noticeMessageSchema,
  turnMessageSchema,
  turnUpdatedMessageSchema,
  turnsFailedMessageSchema,
  turnsMessageSchema,
  turnsRemovedMessageSchema,
} from './conversation';
import { pushEventSchema } from './events-zod';
import { interactionEventMessageSchema } from './interaction';
import {
  agentEventMessageSchema,
  goalEventMessageSchema,
  todoEventMessageSchema,
  usageEventMessageSchema,
} from './ws-agent';
import {
  taskBackgroundMessageSchema,
  taskEventMessageSchema,
  taskListMessageSchema,
  taskOutputMessageSchema,
  taskResponseMessageSchema,
  taskStopMessageSchema,
  taskUnwatchMessageSchema,
  taskWatchMessageSchema,
} from './ws-task';

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
  agent_ids: z.array(z.string().min(1)).min(1).optional(),
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
      'Start receiving agents of one session (agent_ids defaults to the main agent). Every newly added agent first gets a turns frame with its latest page, or turns.failed when its conversation cannot be loaded, then turn, item and notice frames. When the session itself cannot be opened, the ack carries the error code (40401 lists the session in not_found) and nothing is subscribed.',
  },
  {
    type: 'unsubscribe_v2',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: unsubscribeV2MessageSchema,
    ackSchema: unsubscribeV2AckMessageSchema,
    description:
      'Stop receiving agents of one session; without agent_ids the whole session is dropped.',
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
    type: 'task.watch',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: taskWatchMessageSchema,
    ackSchema: taskResponseMessageSchema,
    description:
      'Stream the output of one task owned by agent_id to this connection without a session subscription. The first chunk covers at most tail_bytes; since_offset resumes after output the client already has.',
  },
  {
    type: 'task.unwatch',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: taskUnwatchMessageSchema,
    ackSchema: taskResponseMessageSchema,
    description: "Stop streaming one task's output to this connection.",
  },
  {
    type: 'task.stop',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: taskStopMessageSchema,
    ackSchema: taskResponseMessageSchema,
    description: 'Stop one task; the reply carries its state, and an ended task just replies with it.',
  },
  {
    type: 'task.background',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: taskBackgroundMessageSchema,
    ackSchema: taskResponseMessageSchema,
    description:
      'Stop the tool call that started a task from waiting for it, so the task keeps running in the background; the reply carries its state.',
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

export const taskListEventOperation = {
  type: 'task.list',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: taskListMessageSchema,
  description:
    'Every task an agent is running right now, sent when a connection starts receiving that agent; it replaces the client list.',
} as const satisfies WsOperationDefinition;

export const taskEventOperation = {
  type: 'task',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: taskEventMessageSchema,
  description:
    'Full state of one task of a subscribed agent, sent on every change; the frame for an ended task is its last one.',
} as const satisfies WsOperationDefinition;

export const taskOutputEventOperation = {
  type: 'task.output',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: taskOutputMessageSchema,
  description:
    'Task output starting at a UTF-8 byte offset, sent only to connections watching the task.',
} as const satisfies WsOperationDefinition;

export const agentEventOperation = {
  type: 'agent',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: agentEventMessageSchema,
  description:
    'Status (idle, running or compacting), model, thinking effort, permission mode and plan / swarm / tower mode switches of one subscribed agent, sent when a connection starts receiving that agent and on every change; it replaces the client copy. Request retries ride on the running turn.',
} as const satisfies WsOperationDefinition;

export const usageEventOperation = {
  type: 'usage',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: usageEventMessageSchema,
  description:
    'Context window usage of one subscribed agent, sent when a connection starts receiving that agent and then at most a few times per second while it changes; only the latest value matters.',
} as const satisfies WsOperationDefinition;

export const goalEventOperation = {
  type: 'goal',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: goalEventMessageSchema,
  description:
    'Goal of the main agent, sent when a connection starts receiving it and on every change; goal is omitted when the session has none.',
} as const satisfies WsOperationDefinition;

export const todoEventOperation = {
  type: 'todo',
  direction: 'server_to_client',
  kind: 'event',
  messageSchema: todoEventMessageSchema,
  description:
    'Todo list of one subscribed agent, sent when a connection starts receiving that agent and on every change, including undo; it replaces the client list.',
} as const satisfies WsOperationDefinition;

export const conversationEventOperations = [
  {
    type: 'turns',
    direction: 'server_to_client',
    kind: 'event',
    messageSchema: turnsMessageSchema,
    description:
      'Latest page of turns of an agent, sent when a connection starts receiving that agent, including after a reconnect; it replaces the client copy of those turns. Older pages come from GET /sessions/{session_id}/agents/{agent_id}/turns.',
  },
  {
    type: 'turns.removed',
    direction: 'server_to_client',
    kind: 'event',
    messageSchema: turnsRemovedMessageSchema,
    description:
      'Turns that left the conversation of an agent, in ordinal order: the undone turns after an undo, matching removed_turn_ids of the undo response, or every turn after a context clear. The client removes them by turn_id.',
  },
  {
    type: 'turns.failed',
    direction: 'server_to_client',
    kind: 'event',
    messageSchema: turnsFailedMessageSchema,
    description:
      'The conversation of a subscribed agent could not be loaded; code and msg say why. The agent stays subscribed, and a later turns frame replaces the failure.',
  },
  {
    type: 'turn',
    direction: 'server_to_client',
    kind: 'event',
    messageSchema: turnMessageSchema,
    description:
      'turn.started or turn.ended with the turn without its items; it replaces the client copy of the turn and keeps its items. turn.ended is sent again when an ended turn is corrected.',
  },
  {
    type: 'turn.updated',
    direction: 'server_to_client',
    kind: 'event',
    messageSchema: turnUpdatedMessageSchema,
    description:
      'A step of a running turn ended (step, written into steps by index) or its retry state changed; retry replaces the client copy and an absent retry clears it.',
  },
  {
    type: 'item',
    direction: 'server_to_client',
    kind: 'event',
    messageSchema: itemMessageSchema,
    description:
      'item.started or item.ended with the full item; it replaces the client copy of the item with the same item_id. item.ended is sent once per item, again only for a later authoritative replacement.',
  },
  {
    type: 'item.updated',
    direction: 'server_to_client',
    kind: 'event',
    messageSchema: itemUpdatedMessageSchema,
    description: 'Fields of a running tool_call item that changed; set is merged shallowly into the client copy.',
  },
  {
    type: 'item.delta',
    direction: 'server_to_client',
    kind: 'event',
    messageSchema: itemDeltaMessageSchema,
    description:
      'Text appended to field of a running item: text of assistant_message and reasoning, input_text and output of tool_call.',
  },
  {
    type: 'item.removed',
    direction: 'server_to_client',
    kind: 'event',
    messageSchema: itemRemovedMessageSchema,
    description:
      'A running item that will not be finished, for example after a request retry restarts the step.',
  },
  {
    type: 'notice',
    direction: 'server_to_client',
    kind: 'event',
    messageSchema: noticeMessageSchema,
    description:
      'Live warning or error raised by an agent, such as a context compaction that did not finish; not part of the turns and not sent again on subscribe.',
  },
] as const satisfies readonly WsOperationDefinition[];

export const wsOperations = [
  ...clientControlOperations,
  ...serverSystemOperations,
  sessionEventOperation,
  interactionEventOperation,
  taskListEventOperation,
  taskEventOperation,
  taskOutputEventOperation,
  agentEventOperation,
  usageEventOperation,
  goalEventOperation,
  todoEventOperation,
  ...conversationEventOperations,
] as const satisfies readonly WsOperationDefinition[];

export function getClientControlOperation(
  type: string,
): (typeof clientControlOperations)[number] | undefined {
  return clientControlOperations.find((operation) => operation.type === type);
}
