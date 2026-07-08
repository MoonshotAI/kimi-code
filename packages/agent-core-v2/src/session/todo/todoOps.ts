/**
 * `todo` domain (L4) — wire Model (`TodoModel`) and the `todo.set` Op
 * (`todoSet`) for the session's shared todo list.
 *
 * Declares the todo list as `readonly TodoItem[]` (initial `[]`) plus the single
 * `todo.set` Op whose `apply` replaces the whole list with the payload after
 * sanitizing it through `readTodoItems`. Replayed / hand-written records may
 * carry malformed items, and `apply` is the single log→model boundary that
 * keeps the model clean so every consumer (`getTodos`, the tool render, the
 * stale reminder, the compaction summary) can trust it without re-validating.
 * The Op type (`todo.set`) matches the legacy record type, so `wire.replay`
 * Model from the existing shared append log. Consumed cross-scope by the
 * Session-scope `SessionTodoService`: it dispatches `todo.set` to the MAIN
 * agent's wire (the single source of truth and replayable timeline) and, on
 * `wire.onRestored`, reads the rebuilt Model back from that same wire. The Op
 * registers into the global `OP_REGISTRY` at import time, so it is in place
 * before the main agent replays.
 */

import { defineModel } from '#/wire/model';
import { defineOp } from '#/wire/op';

import { readTodoItems, type TodoItem } from './todoItem';

export type TodoModelState = readonly TodoItem[];

export const TodoModel = defineModel<TodoModelState>('todo', () => []);

export interface TodoSetPayload {
  readonly todos: readonly TodoItem[];
}

export const todoSet = defineOp(TodoModel, 'todo.set', {
  apply: (_s, p: TodoSetPayload): TodoModelState => readTodoItems(p.todos),
});
