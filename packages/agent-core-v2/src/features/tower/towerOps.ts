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

import { z } from 'zod';

import { defineModel } from '#/wire/model';

export const TowerModel = defineModel<boolean>('tower', () => false);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'tower_mode.enter': typeof towerEnter;
    'tower_mode.exit': typeof towerExit;
  }
}

export const towerEnter = TowerModel.defineOp('tower_mode.enter', {
  schema: z.object({}),
  apply: () => true,
  toEvent: () => ({ type: 'agent.status.updated' as const, towerMode: true }),
});

export const towerExit = TowerModel.defineOp('tower_mode.exit', {
  schema: z.object({}),
  apply: () => false,
  toEvent: () => ({ type: 'agent.status.updated' as const, towerMode: false }),
});
