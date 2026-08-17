/**
 * `agentPlugin` domain — durable session-start guidance snapshot.
 *
 * Owns the Agent wire Model that freezes the main agent's rendered plugin
 * session-start guidance until an explicit reload replaces it. Bound at Agent
 * scope through `wire`.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

export interface PluginSessionStartSnapshotState {
  readonly initialized: boolean;
  readonly content?: string;
}

export const PluginSessionStartSnapshotModel = defineModel<PluginSessionStartSnapshotState>(
  'pluginSessionStartSnapshot',
  () => ({ initialized: false }),
);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'plugin.session_start': typeof pluginSessionStartSnapshotSet;
  }
}

export const pluginSessionStartSnapshotSet = PluginSessionStartSnapshotModel.defineOp(
  'plugin.session_start',
  {
    schema: z.object({ content: z.string().nullable() }),
    apply: (_state, { content }) => ({
      initialized: true,
      content: content ?? undefined,
    }),
  },
);
