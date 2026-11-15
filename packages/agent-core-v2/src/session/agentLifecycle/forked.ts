/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';

const forkedSchema = z.object({ agentId: z.string() });

export class Forked extends AgentEvent2<z.infer<typeof forkedSchema>> {
  static override readonly type = 'forked';
  static override readonly durable = true;
  static override readonly schema = forkedSchema;
}
export interface Forked {
  readonly agentId: string;
}
