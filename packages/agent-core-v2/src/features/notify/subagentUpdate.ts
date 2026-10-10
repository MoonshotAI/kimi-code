/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { Event2, registerEvent2Class } from '#/app/event/event2';

export interface SubagentUpdatePayload {
  readonly subagentId: string;
  readonly title: string;
  readonly message: string;
}

export class SubagentUpdate extends Event2<SubagentUpdatePayload> {
  static override readonly type = 'subagent.update';
  static override readonly observable = true;
  static override readonly durable = true;
  static override readonly schema = z.object({
    subagentId: z.string(),
    title: z.string(),
    message: z.string(),
  });
}
export interface SubagentUpdate extends SubagentUpdatePayload {}
registerEvent2Class(SubagentUpdate);

export interface SubagentUpdateEvent extends SubagentUpdatePayload {
  readonly type: 'subagent.update';
}
