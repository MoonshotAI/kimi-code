/**
 * `swarm` domain (L4) — wire Model (`SwarmModel`) and the `swarm_mode.enter` /
 * `swarm_mode.exit` Ops (`swarmEnter` / `swarmExit`) for the agent's swarm mode.
 *
 * Declares swarm mode as a `SwarmModeTrigger | null` wire Model (the trigger is
 * retained, not collapsed to a boolean, so `shouldAutoExit` can still
 * distinguish `task` / `tool`) plus the two Ops that set and clear it; the
 * `apply` functions are the pure extraction of the former live `applyEnter` /
 * `applyExit` and `resume` facets. The `swarmMode` slice of
 * `agent.status.updated` is declared centrally in `usageOps`. Consumed by the
 * Agent-scope `swarmService`.
 */

import { defineModel, defineOp } from '#/wire';

import type { SwarmModeTrigger } from './swarm';

export const SwarmModel = defineModel<SwarmModeTrigger | null>('swarm', () => null);

export const swarmEnter = defineOp(SwarmModel, 'swarm_mode.enter', {
  apply: (_s, p: { trigger: SwarmModeTrigger }) => p.trigger,
  toEvent: () => ({ type: 'agent.status.updated' as const, swarmMode: true }),
});

export const swarmExit = defineOp(SwarmModel, 'swarm_mode.exit', {
  apply: () => null,
  toEvent: () => ({ type: 'agent.status.updated' as const, swarmMode: false }),
});
