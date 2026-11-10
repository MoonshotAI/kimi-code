/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';

import type { TodoItem } from './todoItem';

export type TodoState = readonly TodoItem[];

const toolsUpdateStoreSchema = z.object({
  agentId: z.string(),
  key: z.string(),
  value: z.unknown(),
});

export class ToolsUpdateStore extends AgentEvent2<z.infer<typeof toolsUpdateStoreSchema>> {
  static override readonly type = 'tools.update_store';
  static override readonly durable = true;
  static override readonly schema = toolsUpdateStoreSchema;
}
export interface ToolsUpdateStore {
  readonly agentId: string;
  readonly key: string;
  readonly value: unknown;
}
