/**
 * `swarm` domain — the `swarmKey` state and the durable `swarm_mode.enter`
 * (`SwarmModeEnter`) / `swarm_mode.exit` (`SwarmModeExit`) events for the
 * agent's swarm mode.
 *
 * The state holds `SwarmModeTrigger | null` (initial `null`; the trigger is
 * retained, not collapsed to a boolean, so `shouldAutoExit` can still
 * distinguish `task` / `tool`). The durable classes are the wire-protocol
 * record vocabulary: their `serialize()` output is the on-disk record (flat
 * payload, epoch-ms `time`), byte-compatible with the retired op encoding.
 * Each fold emits the `AgentStatusUpdated` swarm-mode slice after the state
 * commits, live only. The trailing enter-reminder pop on `swarm_mode.exit` is
 * a fold the swarm feature registers onto the core `contextMemoryKey`
 * (`popSwarmModeReminder` returns the same reference on a no-op, and
 * returning the draft keeps the immer base).
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import { contextMemoryKey, popSwarmModeReminder } from '#/agent/contextMemory/contextOps';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { SwarmModeTrigger } from './agent/swarm';

const swarmModeEnterSchema = z.object({ trigger: z.custom<SwarmModeTrigger>() });

export class SwarmModeEnter extends Event2<z.infer<typeof swarmModeEnterSchema>> {
  static override readonly type = 'swarm_mode.enter';
  static override readonly durable = true;
  static override readonly schema = swarmModeEnterSchema;
}
export interface SwarmModeEnter extends z.infer<typeof swarmModeEnterSchema> {}

const swarmModeExitSchema = z.object({});

export class SwarmModeExit extends Event2<z.infer<typeof swarmModeExitSchema>> {
  static override readonly type = 'swarm_mode.exit';
  static override readonly durable = true;
  static override readonly schema = swarmModeExitSchema;
}
export interface SwarmModeExit extends z.infer<typeof swarmModeExitSchema> {}

export const swarmKey = defineState('swarm', (): SwarmModeTrigger | null => null).replayable({
  schema: z.custom<SwarmModeTrigger | null>(),
})
  .on(SwarmModeEnter, (_s, e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ swarmMode: true }));
    return e.trigger;
  })
  .on(SwarmModeExit, (_s, _e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ swarmMode: false }));
    return null;
  });

contextMemoryKey.on(SwarmModeExit, (s) => popSwarmModeReminder(s));
