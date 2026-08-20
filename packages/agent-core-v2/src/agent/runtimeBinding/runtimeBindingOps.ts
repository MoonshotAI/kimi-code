/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import type { RuntimeBinding } from '#/runtime/runtime';
import { defineState } from '#/state/state';

const runtimeSetBindingSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  runtimeId: z.string(),
});

export class RuntimeSetBinding extends AgentEvent2<z.infer<typeof runtimeSetBindingSchema>> {
  static override readonly type = 'runtime.set_binding';
  static override readonly durable = true;
  static override readonly schema = runtimeSetBindingSchema;
}
export interface RuntimeSetBinding {
  readonly agentId: string;
  readonly workspaceId: string;
  readonly runtimeId: string;
}

export const runtimeBindingKey = defineState(
  'runtimeBinding',
  (): RuntimeBinding | undefined => undefined,
).replayable({ schema: z.custom<RuntimeBinding | undefined>() })
  .on(RuntimeSetBinding, (_s, e) => ({ workspaceId: e.workspaceId, runtimeId: e.runtimeId }));
