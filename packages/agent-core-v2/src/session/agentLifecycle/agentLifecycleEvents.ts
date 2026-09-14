/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';

const agentForkSchema = z.object({
  agentId: z.string(),
  forkedFrom: z.string(),
});

export class AgentFork extends AgentEvent2<z.infer<typeof agentForkSchema>> {
  static override readonly type = 'agent.fork';
  static override readonly durable = true;
  static override readonly schema = agentForkSchema;
}
export interface AgentFork {
  readonly agentId: string;
  readonly forkedFrom: string;
}
