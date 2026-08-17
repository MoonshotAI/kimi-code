/**
 * `agentPlugin` domain — durable session-start guidance snapshot.
 *
 * Owns the `pluginSessionStartSnapshotKey` state that freezes the main
 * agent's rendered plugin session-start guidance until an explicit reload
 * replaces it, folded from the durable `plugin.session_start` event
 * (`PluginSessionStartEvent`). Scope-agnostic.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export interface PluginSessionStartSnapshotState {
  readonly initialized: boolean;
  readonly content?: string;
}

const pluginSessionStartSchema = z.object({ content: z.string().nullable() });

export class PluginSessionStartEvent extends Event2<z.infer<typeof pluginSessionStartSchema>> {
  static override readonly type = 'plugin.session_start';
  static override readonly durable = true;
  static override readonly schema = pluginSessionStartSchema;
}
export interface PluginSessionStartEvent extends z.infer<typeof pluginSessionStartSchema> {}

export const pluginSessionStartSnapshotKey = defineState(
  'pluginSessionStartSnapshot',
  (): PluginSessionStartSnapshotState => ({ initialized: false }),
)
  .replayable({ schema: z.custom<PluginSessionStartSnapshotState>() })
  .on(PluginSessionStartEvent, (_s, e) => ({
    initialized: true,
    content: e.content ?? undefined,
  }));
