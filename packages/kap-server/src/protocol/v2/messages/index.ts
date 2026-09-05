import { z } from 'zod';

import { turnMessageSchema } from './turn';
import { stepMessageSchema } from './step';
import { userMessageSchema } from './user';
import { assistantMessageSchema, thinkingMessageSchema } from './assistant';
import {
  assistantDeltaMessageSchema,
  thinkingDeltaMessageSchema,
  toolCallDeltaMessageSchema,
  toolProgressMessageSchema,
} from './delta';
import { toolCallMessageSchema } from './tool-call';
import { interactionMessageSchema } from './interaction';
import { agentMessageSchema } from './agent';
import { taskMessageSchema } from './task';
import { todoMessageSchema } from './todo';
import { systemMessageSchema } from './system';
import { sessionMessageSchema, sessionStateMessageSchema } from './session-state';
import { workspaceMessageSchema } from './workspace';
import {
  capabilityChangedMessageSchema,
  configMessageSchema,
  configWarningMessageSchema,
  modelCatalogChangedMessageSchema,
  pluginChangedMessageSchema,
} from './config';
import { ackMessageSchema, errorMessageSchema, helloMessageSchema } from './control';

export * from './base';
export * from './turn';
export * from './step';
export * from './user';
export * from './assistant';
export * from './delta';
export * from './tool-call';
export * from './interaction';
export * from './agent';
export * from './task';
export * from './todo';
export * from './system';
export * from './session-state';
export * from './workspace';
export * from './config';
export * from './control';
export * from './entity-id';

export const serverMessageSchema = z.discriminatedUnion('type', [
  turnMessageSchema,
  stepMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  thinkingMessageSchema,
  assistantDeltaMessageSchema,
  thinkingDeltaMessageSchema,
  toolCallMessageSchema,
  toolCallDeltaMessageSchema,
  toolProgressMessageSchema,
  systemMessageSchema,
  interactionMessageSchema,
  agentMessageSchema,
  taskMessageSchema,
  todoMessageSchema,
  sessionStateMessageSchema,
  sessionMessageSchema,
  workspaceMessageSchema,
  configMessageSchema,
  configWarningMessageSchema,
  modelCatalogChangedMessageSchema,
  pluginChangedMessageSchema,
  capabilityChangedMessageSchema,
  helloMessageSchema,
  ackMessageSchema,
  errorMessageSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export class ContractViolation extends Error {
  readonly issues: z.core.$ZodIssue[];
  readonly raw: unknown;

  constructor(issues: z.core.$ZodIssue[], raw: unknown) {
    super(`ws2 contract violation: ${issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    this.name = 'ContractViolation';
    this.issues = issues;
    this.raw = raw;
  }
}

export function parseServerMessage(raw: unknown): ServerMessage {
  const result = serverMessageSchema.safeParse(raw);
  if (!result.success) throw new ContractViolation(result.error.issues, raw);
  return result.data;
}
