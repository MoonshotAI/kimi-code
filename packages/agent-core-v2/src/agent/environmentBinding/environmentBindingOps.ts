/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import type { EnvironmentBinding } from '#/environment/environment';
import { defineState } from '#/state/state';

const environmentSetBindingSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  environmentId: z.string(),
  cwd: z.string().optional(),
});

export class EnvironmentSetBinding extends AgentEvent2<z.infer<typeof environmentSetBindingSchema>> {
  static override readonly type = 'environment.set_binding';
  static override readonly durable = true;
  static override readonly schema = environmentSetBindingSchema;
}
export interface EnvironmentSetBinding {
  readonly agentId: string;
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly cwd?: string;
}

export const environmentBindingKey = defineState(
  'environmentBinding',
  (): EnvironmentBinding | undefined => undefined,
).replayable({ schema: z.custom<EnvironmentBinding | undefined>() })
  .on(EnvironmentSetBinding, (_s, e) => ({ workspaceId: e.workspaceId, environmentId: e.environmentId, cwd: e.cwd }));
