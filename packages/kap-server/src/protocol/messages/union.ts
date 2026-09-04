import { z } from 'zod';

import { ackMessageSchema } from './ack';
import { assistantMessageSchema } from './assistant';
import { assistantDeltaMessageSchema } from './assistant-delta';
import { capabilityMessageSchema } from './capability';
import { configMessageSchema } from './config';
import { configWarningMessageSchema } from './config-warning';
import { errorMessageSchema } from './error';
import { helloMessageSchema } from './hello';
import { interactionMessageSchema } from './interaction';
import { modelCatalogMessageSchema } from './model-catalog';
import { pluginMessageSchema } from './plugin';
import { sessionMessageSchema } from './session';
import { sessionStateMessageSchema } from './session-state';
import { stepMessageSchema } from './step';
import { subscribeMessageSchema } from './subscribe';
import { systemMessageSchema } from './system';
import { taskMessageSchema } from './task';
import { thinkingMessageSchema } from './thinking';
import { thinkingDeltaMessageSchema } from './thinking-delta';
import { todoMessageSchema } from './todo';
import { toolCallMessageSchema } from './tool-call';
import { toolCallDeltaMessageSchema } from './tool-call-delta';
import { toolProgressMessageSchema } from './tool-progress';
import { turnMessageSchema } from './turn';
import { unsubscribeMessageSchema } from './unsubscribe';
import { userMessageSchema } from './user';
import { workspaceMessageSchema } from './workspace';

export const serverMessageSchema = z.discriminatedUnion('type', [
  turnMessageSchema,
  stepMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  assistantDeltaMessageSchema,
  thinkingMessageSchema,
  thinkingDeltaMessageSchema,
  toolCallMessageSchema,
  toolCallDeltaMessageSchema,
  toolProgressMessageSchema,
  systemMessageSchema,
  interactionMessageSchema,
  taskMessageSchema,
  todoMessageSchema,
  sessionStateMessageSchema,
  sessionMessageSchema,
  workspaceMessageSchema,
  configMessageSchema,
  configWarningMessageSchema,
  modelCatalogMessageSchema,
  pluginMessageSchema,
  capabilityMessageSchema,
  helloMessageSchema,
  ackMessageSchema,
  errorMessageSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;

export const clientMessageSchema = z.discriminatedUnion('type', [
  subscribeMessageSchema,
  unsubscribeMessageSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
