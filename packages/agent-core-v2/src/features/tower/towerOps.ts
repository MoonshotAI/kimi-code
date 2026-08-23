/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

const towerModeEnterSchema = z.object({ agentId: z.string(), sessionId: z.string().optional() });

export class TowerModeEnter extends AgentEvent2<z.infer<typeof towerModeEnterSchema>> {
  static override readonly type = 'tower_mode.enter';
  static override readonly durable = true;
  static override readonly schema = towerModeEnterSchema;
}
export interface TowerModeEnter {
  readonly agentId: string;
  readonly sessionId?: string;
}

const towerModeExitSchema = z.object({ agentId: z.string() });

export class TowerModeExit extends AgentEvent2<z.infer<typeof towerModeExitSchema>> {
  static override readonly type = 'tower_mode.exit';
  static override readonly durable = true;
  static override readonly schema = towerModeExitSchema;
}
export interface TowerModeExit {
  readonly agentId: string;
}

export const towerKey = defineState('tower', () => false).replayable({
  schema: z.boolean(),
})
  .on(TowerModeEnter, (_s, e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, towerMode: true }));
    return true;
  })
  .on(TowerModeExit, (_s, e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, towerMode: false }));
    return false;
  });

export const towerOwnerKey = defineState('tower.owner', () => undefined as string | undefined)
  .replayable({
    schema: z.string().optional(),
  })
  .on(TowerModeEnter, (_s, e) => e.sessionId)
  .on(TowerModeExit, () => undefined);
