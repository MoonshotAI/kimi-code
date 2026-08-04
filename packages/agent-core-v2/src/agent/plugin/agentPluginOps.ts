/**
 * `agentPlugin` domain (L4) — persistent plugin session-start baseline.
 *
 * Defines the checkpointed Agent wire model used by `agentPlugin` to keep the
 * last model-facing session-start fingerprint aligned with replay, resume, and
 * conversation undo.
 */

import { z } from 'zod';

import { defineCheckpointedModel } from '#/agent/contextMemory/conversationTime';

export interface AgentPluginModelState {
  readonly sessionStartFingerprint?: string;
  readonly sessionStartActive: boolean;
}

export const AgentPluginModel = defineCheckpointedModel<AgentPluginModelState>(
  'agentPlugin',
  () => ({ sessionStartActive: false }),
);

export const setPluginSessionStartBaseline = AgentPluginModel.defineOp(
  'plugin.session_start.set_baseline',
  {
    schema: z.object({
      fingerprint: z.string(),
      active: z.boolean(),
    }),
    apply: (state, payload) =>
      state.current.sessionStartFingerprint === payload.fingerprint &&
      state.current.sessionStartActive === payload.active
        ? state
        : {
            ...state,
            current: {
              sessionStartFingerprint: payload.fingerprint,
              sessionStartActive: payload.active,
            },
          },
  },
);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'plugin.session_start.set_baseline': typeof setPluginSessionStartBaseline;
  }
}
