/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import type { EnvironmentBinding } from '#/environment/environment';
import { defineState } from '#/state/state';

const environmentSetBindingSchema = z.object({
  agentId: z.string(),
  environmentId: z.string(),
  cwd: z.string().optional(),
});

const runtimeSetBindingSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  runtimeId: z.string(),
});

export class EnvironmentSetBinding extends AgentEvent2<z.infer<typeof environmentSetBindingSchema>> {
  static override readonly type = 'environment.set_binding';
  static override readonly durable = true;
  static override readonly schema = environmentSetBindingSchema;
}
export interface EnvironmentSetBinding {
  readonly agentId: string;
  readonly environmentId: string;
  readonly cwd?: string;
}

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

export const environmentBindingKey = defineState(
  'environmentBinding',
  (): EnvironmentBinding | undefined => undefined,
).replayable({ schema: z.custom<EnvironmentBinding | undefined>() })
  .on(EnvironmentSetBinding, (_s, e) => ({ environmentId: e.environmentId, cwd: e.cwd }))
  .on(RuntimeSetBinding, (_s, e) => ({ environmentId: e.runtimeId }));
