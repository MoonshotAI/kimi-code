/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

export type StaleGuardModelState = Map<string, number>;

const staleGuardRecordedSchema = z.object({
  path: z.string(),
  mtimeMs: z.number(),
});

export class StaleGuardRecorded extends Event2<z.infer<typeof staleGuardRecordedSchema>> {
  static override readonly type = 'staleGuard.recorded';
  static override readonly durable = true;
  static override readonly schema = staleGuardRecordedSchema;
}
export interface StaleGuardRecorded extends z.infer<typeof staleGuardRecordedSchema> {}

const staleGuardClearedSchema = z.object({});

export class StaleGuardCleared extends Event2<z.infer<typeof staleGuardClearedSchema>> {
  static override readonly type = 'staleGuard.cleared';
  static override readonly durable = true;
  static override readonly schema = staleGuardClearedSchema;
}
export interface StaleGuardCleared extends z.infer<typeof staleGuardClearedSchema> {}

export const staleGuardKey = defineState(
  'staleGuard',
  (): StaleGuardModelState => new Map(),
).replayable({
  schema: z.custom<StaleGuardModelState>(),
})
  .on(StaleGuardRecorded, (s, e) => {
    s.set(e.path, e.mtimeMs);
  })
  .on(StaleGuardCleared, (s) => {
    s.clear();
  });
