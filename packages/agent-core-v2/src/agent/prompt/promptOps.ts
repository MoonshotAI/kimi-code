/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

const promptAcceptedSchema = z.object({
  agentId: z.string(),
  promptId: z.string().min(1),
});

export class PromptAccepted extends AgentEvent2<z.infer<typeof promptAcceptedSchema>> {
  static override readonly type = 'prompt.accepted';
  static override readonly durable = true;
  static override readonly schema = promptAcceptedSchema;
}
export interface PromptAccepted {
  readonly agentId: string;
  readonly promptId: string;
}

export const promptAdmissionKey = defineState('promptAdmission', (): Map<string, true> => new Map())
  .replayable({ schema: z.map(z.string(), z.literal(true)) })
  .on(PromptAccepted, (state, event) => {
    if (state.has(event.promptId)) return state;
    state.set(event.promptId, true);
  });
