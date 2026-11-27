/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import type { EnvironmentBinding } from '#/environment/environment';
import { defineState } from '#/state/state';

export interface ProjectAgentsMdBelief {
  readonly relativePath: string;
  readonly path: string;
  readonly hash: string;
}

export interface WorkdirMoveBaseline {
  readonly cwd: string;
  readonly checkoutRoot: string;
  readonly projectAgentsMd: readonly ProjectAgentsMdBelief[];
}

const projectAgentsMdBeliefSchema = z.object({
  relativePath: z.string(),
  path: z.string(),
  hash: z.string(),
});

const workdirMoveBaselineSchema = z.object({
  cwd: z.string(),
  checkoutRoot: z.string(),
  projectAgentsMd: z.array(projectAgentsMdBeliefSchema).readonly(),
});

const environmentSetBindingSchema = z.object({
  agentId: z.string(),
  environmentId: z.string(),
  cwd: z.string().optional(),
  originCwd: z.string().nullable().optional(),
  pendingBaseline: workdirMoveBaselineSchema.nullable().optional(),
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
  readonly originCwd?: string | null;
  readonly pendingBaseline?: WorkdirMoveBaseline | null;
}

export const environmentBindingKey = defineState(
  'environmentBinding',
  (): EnvironmentBinding | undefined => undefined,
).replayable({ schema: z.custom<EnvironmentBinding | undefined>() })
  .on(EnvironmentSetBinding, (_s, e) => ({ environmentId: e.environmentId, cwd: e.cwd }));
