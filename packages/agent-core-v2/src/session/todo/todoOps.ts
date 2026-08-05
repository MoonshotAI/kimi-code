/**
 * `todo` domain — persists the session's shared todo document.
 *
 * Validates todo state against the item contract and keeps it aligned with
 * conversation undo.
 */

import { z } from 'zod';

import {
  defineCheckpointedModel,
  type Checkpointed,
} from '#/agent/contextMemory/conversationTime';

import { readTodoItems, type TodoItem } from './todoItem';

export type TodoModelState = Checkpointed<readonly TodoItem[]>;

export const TodoModel = defineCheckpointedModel('todo', (): readonly TodoItem[] => []);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'tools.update_store': typeof todoSet;
  }
}

export const todoSet = TodoModel.defineOp('tools.update_store', {
  schema: z.object({ key: z.string(), value: z.unknown() }),
  apply: (s, p) =>
    p.key === 'todo' ? { ...s, current: readTodoItems(p.value) } : s,
});
