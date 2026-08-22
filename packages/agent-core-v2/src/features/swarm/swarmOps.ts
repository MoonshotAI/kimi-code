/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { contextMemoryKey, popSwarmModeReminder } from '#/agent/contextMemory/contextOps';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { SwarmModeTrigger } from './agent/swarm';

const swarmModeEnterSchema = z.object({
  agentId: z.string(),
  trigger: z.custom<SwarmModeTrigger>(),
});

export class SwarmModeEnter extends AgentEvent2<z.infer<typeof swarmModeEnterSchema>> {
  static override readonly type = 'swarm_mode.enter';
  static override readonly durable = true;
  static override readonly schema = swarmModeEnterSchema;
}
export interface SwarmModeEnter {
  readonly agentId: string;
  readonly trigger: SwarmModeTrigger;
}

const swarmModeExitSchema = z.object({ agentId: z.string() });

export class SwarmModeExit extends AgentEvent2<z.infer<typeof swarmModeExitSchema>> {
  static override readonly type = 'swarm_mode.exit';
  static override readonly durable = true;
  static override readonly schema = swarmModeExitSchema;
}
export interface SwarmModeExit {
  readonly agentId: string;
}

export const swarmKey = defineState('swarm', (): SwarmModeTrigger | null => null).replayable({
  schema: z.custom<SwarmModeTrigger | null>(),
})
  .on(SwarmModeEnter, (_s, e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, swarmMode: true }));
    return e.trigger;
  })
  .on(SwarmModeExit, (_s, e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, swarmMode: false }));
    return null;
  });

contextMemoryKey.on(SwarmModeExit, (s) => popSwarmModeReminder(s));
