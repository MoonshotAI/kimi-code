/**
 * `tower` domain — wire Model (`TowerModel`) and the `tower_mode.enter` /
 * `tower_mode.exit` Ops (`towerEnter` / `towerExit`) for the agent's tower
 * mode.
 *
 * Declares tower mode as a boolean wire Model plus the two Ops that set and
 * clear it — v1's `tower_mode.*` records carry no payload, so replaying a
 * legacy session restores the flag through these Ops with no dedicated
 * restore path. Each Op's `toEvent` publishes the `towerMode` slice of
 * `agent.status.updated` on the live path.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

const towerModeEnterSchema = z.object({});

export class TowerModeEnter extends Event2<z.infer<typeof towerModeEnterSchema>> {
  static override readonly type = 'tower_mode.enter';
  static override readonly durable = true;
  static override readonly schema = towerModeEnterSchema;
}
export interface TowerModeEnter extends z.infer<typeof towerModeEnterSchema> {}

const towerModeExitSchema = z.object({});

export class TowerModeExit extends Event2<z.infer<typeof towerModeExitSchema>> {
  static override readonly type = 'tower_mode.exit';
  static override readonly durable = true;
  static override readonly schema = towerModeExitSchema;
}
export interface TowerModeExit extends z.infer<typeof towerModeExitSchema> {}

export const towerKey = defineState('tower', () => false).replayable({
  schema: z.boolean(),
})
  .on(TowerModeEnter, (_s, _e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ towerMode: true }));
    return true;
  })
  .on(TowerModeExit, (_s, _e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ towerMode: false }));
    return false;
  });
