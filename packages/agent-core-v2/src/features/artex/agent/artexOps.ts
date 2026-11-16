/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { AgentEvent2 } from '#/app/event/event2';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { defineState } from '#/state/state';

export interface ArtexModeState {
  readonly active: boolean;
  readonly explorationId?: number;
}

const artexModeEnterSchema = z.object({
  agentId: z.string(),
  explorationId: z.number().int().optional(),
});

export class ArtexModeEnter extends AgentEvent2<z.infer<typeof artexModeEnterSchema>> {
  static override readonly type = 'artex_mode.enter';
  static override readonly durable = true;
  static override readonly schema = artexModeEnterSchema;
}
export interface ArtexModeEnter {
  readonly agentId: string;
  readonly explorationId?: number;
}

const artexModeExitSchema = z.object({
  agentId: z.string(),
  reason: z.string().optional(),
});

export class ArtexModeExit extends AgentEvent2<z.infer<typeof artexModeExitSchema>> {
  static override readonly type = 'artex_mode.exit';
  static override readonly durable = true;
  static override readonly schema = artexModeExitSchema;
}
export interface ArtexModeExit {
  readonly agentId: string;
  readonly reason?: string;
}

const artexExplorationUpdatedSchema = z.object({
  agentId: z.string(),
  explorationId: z.number().int().optional(),
});

export class ArtexExplorationUpdated extends AgentEvent2<
  z.infer<typeof artexExplorationUpdatedSchema>
> {
  static override readonly type = 'artex.exploration.updated';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = artexExplorationUpdatedSchema;
}
export interface ArtexExplorationUpdated {
  readonly agentId: string;
  readonly explorationId?: number;
}

export const ARTEX_EXPLORATION_UPDATED_EVENT_TYPE = 'artex.exploration.updated' as const;

export const artexKey = defineState('artex', (): ArtexModeState => ({ active: false }))
  .replayable({ schema: z.custom<ArtexModeState>() })
  .undoable()
  .on(ArtexModeEnter, (s, e, ctx) => {
    if (e.agentId !== MAIN_AGENT_ID) return;
    s.active = true;
    if (e.explorationId !== undefined) s.explorationId = e.explorationId;
    ctx.emit(
      new AgentStatusUpdated({
        agentId: e.agentId,
        artexMode: true,
        artexExplorationId: s.explorationId,
      }),
    );
  })
  .on(ArtexModeExit, (s, e, ctx) => {
    if (s.active) {
      s.active = false;
    }
    ctx.emit(
      new AgentStatusUpdated({
        agentId: e.agentId,
        artexMode: false,
        artexExplorationId: undefined,
      }),
    );
  })
  .on(ArtexExplorationUpdated, (s, e, ctx) => {
    if (e.agentId !== MAIN_AGENT_ID) return;
    if (e.explorationId === undefined) delete s.explorationId;
    else s.explorationId = e.explorationId;
    if (s.active) {
      ctx.emit(
        new AgentStatusUpdated({
          agentId: e.agentId,
          artexMode: true,
          artexExplorationId: s.explorationId,
        }),
      );
    }
  });
