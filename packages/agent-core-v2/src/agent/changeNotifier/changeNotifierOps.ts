/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export interface ChangeNotifierSnapshotState {
  readonly agentsMdHash?: string;
  readonly skillsHash?: string;
  readonly subagentNames?: readonly string[];
  readonly modelPoolAliases?: readonly string[];
}

const changeNotifierSnapshotSchema = z.object({
  agentId: z.string(),
  agentsMdHash: z.string().nullable(),
  skillsHash: z.string().nullable(),
  subagentNames: z.array(z.string()).readonly().nullable(),
  modelPoolAliases: z.array(z.string()).readonly().nullable(),
});

export class ChangeNotifierSnapshotEvent extends AgentEvent2<
  z.infer<typeof changeNotifierSnapshotSchema>
> {
  static override readonly type = 'changeNotifier.snapshot';
  static override readonly durable = true;
  static override readonly schema = changeNotifierSnapshotSchema;
}
export interface ChangeNotifierSnapshotEvent {
  readonly agentId: string;
  readonly agentsMdHash: string | null;
  readonly skillsHash: string | null;
  readonly subagentNames: readonly string[] | null;
  readonly modelPoolAliases: readonly string[] | null;
}

export const changeNotifierSnapshotKey = defineState(
  'changeNotifier.snapshot',
  (): ChangeNotifierSnapshotState => ({}),
)
  .replayable({ schema: z.custom<ChangeNotifierSnapshotState>() })
  .on(ChangeNotifierSnapshotEvent, (_s, e) => ({
    agentsMdHash: e.agentsMdHash ?? undefined,
    skillsHash: e.skillsHash ?? undefined,
    subagentNames: e.subagentNames ?? undefined,
    modelPoolAliases: e.modelPoolAliases ?? undefined,
  }));
