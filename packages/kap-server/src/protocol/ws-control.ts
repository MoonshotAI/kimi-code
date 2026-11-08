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
import { towerActivityEventSchema, towerProjectionResponseSchema } from './rest-tower';
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
  taskStateSchema,
  taskStopMessageSchema,
  taskUnwatchMessageSchema,
  taskWatchMessageSchema,
} from './ws-task';

export const wsEventEnvelopeSchema = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    type: z.string(),
    session_id: z.string().optional(),
    timestamp: isoDateTimeSchema,
    payload,
  });

export const subscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  agent_ids: z.array(z.string().min(1)).min(1).optional(),
});

export const unsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  request_id: z.string().min(1),
  session_id: z.string().min(1),
  agent_ids: z.array(z.string().min(1)).min(1).optional(),
});

export const responseMessageSchema = z.object({
  type: z.literal('response'),
  request_id: z.string(),
  code: z.number().int(),
  msg: z.string().optional(),
  task: taskStateSchema.optional(),
});

export type ResponseMessage = z.infer<typeof responseMessageSchema>;

export const subscribeTowerMessageSchema = z.object({
  type: z.literal('tower.subscribe'),
  request_id: z.string().min(1),
  workspace_id: z.string().min(1),
});

export type SubscribeTowerMessage = z.infer<typeof subscribeTowerMessageSchema>;

export const unsubscribeTowerMessageSchema = z.object({
  type: z.literal('tower.unsubscribe'),
  request_id: z.string().min(1),
  workspace_id: z.string().min(1),
});

export type UnsubscribeTowerMessage = z.infer<typeof unsubscribeTowerMessageSchema>;

export const towerStatePayloadSchema = z
  .object({ workspace_id: z.string().min(1) })
  .extend(towerProjectionResponseSchema.shape);

export const towerStateMessageSchema = wsEventEnvelopeSchema(towerStatePayloadSchema).extend({
  type: z.literal('tower.state'),
});

export type TowerStateMessage = z.infer<typeof towerStateMessageSchema>;

export const towerActivityPayloadSchema = z.object({
  workspace_id: z.string().min(1),
  events: z.array(towerActivityEventSchema),
  offset: z.number().int().nonnegative(),
});

export const towerActivityMessageSchema = wsEventEnvelopeSchema(towerActivityPayloadSchema).extend({
  type: z.literal('tower.activity'),
});

export type TowerActivityMessage = z.infer<typeof towerActivityMessageSchema>;

export const pingMessageSchema = z.object({
  type: z.literal('ping'),
});

export const pongMessageSchema = z.object({
  type: z.literal('pong'),
});

export const sessionEventMessageSchema = wsEventEnvelopeSchema(pushEventSchema);

export type WsOperationDirection = 'client_to_server' | 'server_to_client';

export type WsOperationKind = 'control' | 'system' | 'event';

export interface WsOperationDefinition {
  readonly type: string;
  readonly direction: WsOperationDirection;
  readonly kind: WsOperationKind;
  readonly messageSchema: z.ZodTypeAny;
  readonly description: string;
}

export const clientControlOperations = [
  {
    type: 'subscribe',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: subscribeMessageSchema,
    description:
      'Start receiving agents of one session (agent_ids defaults to the main agent). The response comes first; then every newly added agent gets a turns frame with its latest page, or turns.failed when its conversation cannot be loaded, then turn, item and notice frames. When the session itself cannot be opened, the response carries the error code (40401 when it does not exist) and nothing is subscribed.',
  },
  {
    type: 'unsubscribe',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: unsubscribeMessageSchema,
    description:
      'Stop receiving agents of one session; without agent_ids the whole session is dropped.',
  },
  {
    type: 'tower.subscribe',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: subscribeTowerMessageSchema,
    description:
      'Start receiving the tower projection of one workspace: the response comes first (40410 when the workspace does not exist), then a tower.state frame with the full snapshot (recent whitelisted events and the current activity.log byte offset), then tower.state whenever state.json changes and tower.activity for whitelisted lines appended to activity.log.',
  },
  {
    type: 'tower.unsubscribe',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: unsubscribeTowerMessageSchema,
    description: 'Stop receiving tower frames of one workspace.',
  },
  {
    type: 'task.watch',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: taskWatchMessageSchema,
    description:
      'Stream the output of one task owned by agent_id to this connection without a session subscription. The first chunk covers at most tail_bytes; since_offset resumes after output the client already has.',
  },
  {
    type: 'task.unwatch',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: taskUnwatchMessageSchema,
    description: "Stop streaming one task's output to this connection.",
  },
  {
    type: 'task.stop',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: taskStopMessageSchema,
    description: 'Stop one task; the response carries its state, and an ended task just replies with it.',
  },
  {
    type: 'task.background',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: taskBackgroundMessageSchema,
    description:
      'Stop the tool call that started a task from waiting for it, so the task keeps running in the background; the response carries its state.',
  },
  {
    type: 'pong',
    direction: 'client_to_server',
    kind: 'control',
    messageSchema: pongMessageSchema,
    description: 'Reply to a server ping.',
  },
] as const satisfies readonly WsOperationDefinition[];

export const serverSystemOperations = [
  {
    type: 'response',
    direction: 'server_to_client',
    kind: 'system',
    messageSchema: responseMessageSchema,
    description:
      'Reply to one client command, matched by request_id; code 0 means success. Replies to task.watch, task.stop and task.background carry the task state. A command without a request_id closes the connection with code 1008.',
  },
  {
    type: 'ping',
    direction: 'server_to_client',
    kind: 'system',
    messageSchema: pingMessageSchema,
    description:
      'Heartbeat sent by the server every 10 seconds; clients answer with pong. The server closes a connection that sends nothing for 20 seconds, and a client that receives nothing for 25 seconds should reconnect.',
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

export const towerEventOperations = [
  {
    type: 'tower.state',
    direction: 'server_to_client',
    kind: 'event',
    messageSchema: towerStateMessageSchema,
    description:
      'Full tower projection of a subscribed workspace, sent right after tower.subscribe and whenever state.json changes; it replaces the client copy. events holds the recent whitelisted activity lines and log_offset the current activity.log byte offset.',
  },
  {
    type: 'tower.activity',
    direction: 'server_to_client',
    kind: 'event',
    messageSchema: towerActivityMessageSchema,
    description:
      'Whitelisted activity lines appended to activity.log of a subscribed workspace; offset is the new byte offset and advances even when no line survives the whitelist.',
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
  ...towerEventOperations,
  ...conversationEventOperations,
] as const satisfies readonly WsOperationDefinition[];
