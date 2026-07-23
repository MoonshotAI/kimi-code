/**
 * `todo` domain (L4) — persists the session's shared todo document.
 *
 * Validates todo state through the local item contract, keeps it aligned with
 * conversation undo through `contextMemory`, and serves the Session-scope todo
 * facade from the main agent's wire.
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
