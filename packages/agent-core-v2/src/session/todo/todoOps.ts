/**
 * `todo` domain (L4) — wire Model (`TodoModel`) and the `tools.update_store`
 * Op (`todoSet`) for the session's shared todo list.
 *
 * Declares the todo list as `readonly TodoItem[]` (initial `[]`). The
 * persisted record is v1's `tools.update_store` (`{ key: 'todo', value }`), so
 * the on-disk vocabulary stays exactly v1's and `wire.replay` — of both v2 and
 * v1 sessions — rebuilds the Model from the shared append log. `apply` is the
 * single log→model boundary: it ignores non-`todo` keys and sanitizes the
 * value through `readTodoItems`, so every consumer (`getTodos`, the tool
 * render, the stale reminder, the compaction summary) can trust the Model
 * without re-validating. Consumed cross-scope by the Session-scope
 * `SessionTodoService`: it dispatches to the MAIN agent's wire (the single
 * source of truth and replayable timeline) and, on `wire.onRestored`, reads the
 * rebuilt Model back from that same wire. The Ops register into the global
 * `OP_REGISTRY` at import time, so they are in place before the main agent
 * replays.
 */

import { defineModel } from '#/wire/model';
import { defineOp } from '#/wire/op';

import { readTodoItems, type TodoItem } from './todoItem';

export type TodoModelState = readonly TodoItem[];

export const TodoModel = defineModel<TodoModelState>('todo', () => []);

export interface ToolStoreUpdatePayload {
  readonly key: string;
  readonly value: unknown;
}

export const todoSet = defineOp(TodoModel, 'tools.update_store', {
  apply: (s, p: ToolStoreUpdatePayload): TodoModelState =>
    p.key === 'todo' ? readTodoItems(p.value) : s,
});
