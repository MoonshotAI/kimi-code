/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export interface PluginSessionStartSnapshotState {
  readonly initialized: boolean;
  readonly content?: string;
}

const pluginSessionStartSchema = z.object({
  agentId: z.string(),
  content: z.string().nullable(),
});

export class PluginSessionStartEvent extends AgentEvent2<
  z.infer<typeof pluginSessionStartSchema>
> {
  static override readonly type = 'plugin.session_start';
  static override readonly durable = true;
  static override readonly schema = pluginSessionStartSchema;
}
export interface PluginSessionStartEvent {
  readonly agentId: string;
  readonly content: string | null;
}

export const pluginSessionStartSnapshotKey = defineState(
  'pluginSessionStartSnapshot',
  (): PluginSessionStartSnapshotState => ({ initialized: false }),
)
  .replayable({ schema: z.custom<PluginSessionStartSnapshotState>() })
  .on(PluginSessionStartEvent, (_s, e) => ({
    initialized: true,
    content: e.content ?? undefined,
  }));
