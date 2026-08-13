/**
 * `todo` domain — persists the session's shared todo document.
 *
 * Validates todo state against the item contract and keeps it aligned with
 * conversation undo through the undoable state protocol. The
 * `tools.update_store` durable event is the v1 wire vocabulary shared with
 * other store keys; the todo fold only reacts to the `todo` key.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import '#/agent/contextMemory/conversationTime';

import { readTodoItems, type TodoItem } from './todoItem';

export type TodoState = readonly TodoItem[];

const toolsUpdateStoreSchema = z.object({ key: z.string(), value: z.unknown() });

export class ToolsUpdateStore extends Event2<z.infer<typeof toolsUpdateStoreSchema>> {
  static override readonly type = 'tools.update_store';
  static override readonly durable = true;
  static override readonly schema = toolsUpdateStoreSchema;
}
export interface ToolsUpdateStore extends z.infer<typeof toolsUpdateStoreSchema> {}

export const todoKey = defineState('todo', (): TodoState => [])
  .replayable({ schema: z.custom<TodoState>() })
  .undoable()
  .on(ToolsUpdateStore, (s, e) => {
    if (e.key !== 'todo') return;
    return readTodoItems(e.value);
  });
