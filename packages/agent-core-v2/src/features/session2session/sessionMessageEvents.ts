import { z } from 'zod';

import type { SessionMessageOrigin } from '#/agent/contextMemory/types';
import { AgentEvent2, registerEvent2Class } from '#/app/event/event2';

export interface SessionMessageSentPayload {
  readonly agentId: string;
  readonly toSessionId: string;
  readonly message: string;
  readonly origin: SessionMessageOrigin;
}

const sessionMessageSentSchema = z.object({
  agentId: z.string(),
  toSessionId: z.string(),
  message: z.string(),
  origin: z.custom<SessionMessageOrigin>(),
});

export class SessionMessageSent extends AgentEvent2<SessionMessageSentPayload> {
  static override readonly type = 'session_message.sent';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = sessionMessageSentSchema;

  declare readonly agentId: string;
  declare readonly toSessionId: string;
  declare readonly message: string;
  declare readonly origin: SessionMessageOrigin;
}

registerEvent2Class(SessionMessageSent);
