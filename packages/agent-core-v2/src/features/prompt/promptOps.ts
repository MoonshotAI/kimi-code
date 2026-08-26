/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';

const promptAcceptedSchema = z.object({
  agentId: z.string(),
  promptId: z.string().min(1),
  content: z.unknown().optional(),
});

export class PromptAccepted extends AgentEvent2<z.infer<typeof promptAcceptedSchema>> {
  static override readonly type = 'prompt.accepted';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = promptAcceptedSchema;
}
export interface PromptAccepted {
  readonly agentId: string;
  readonly promptId: string;
  readonly content?: unknown;
}
