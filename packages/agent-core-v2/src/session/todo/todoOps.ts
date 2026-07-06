/**
 * `todo` domain (L4) — wire Model (`TodoModel`) and the `todo.set` Op
 * (`todoSet`) for the session's shared todo list.
 *
 * Declares the todo list as `readonly TodoItem[]` (initial `[]`) plus the single
 * `todo.set` Op whose `apply` is a pure replace — the whole list is carried in
 * the payload — returning the same reference when the payload is already the
 * current list so the wire's reference-equality gate stays quiet. The Op type
 * (`todo.set`) matches the legacy record type, so `wire.replay` rebuilds the
 * Model from the existing shared append log. Consumed cross-scope by the
 * Session-scope `SessionTodoService`: it dispatches `todo.set` to the MAIN
 * agent's wire (the single source of truth and replayable timeline) and, on
 * `wire.onRestored`, reads the rebuilt Model back from that same wire. The Op
 * registers into the global `OP_REGISTRY` at import time, so it is in place
 * before the main agent replays.
 */

import { defineModel, defineOp } from '#/wire';

import type { TodoItem } from './todoItem';

export type TodoModelState = readonly TodoItem[];

export const TodoModel = defineModel<TodoModelState>('todo', () => []);

export interface TodoSetPayload {
  readonly todos: readonly TodoItem[];
}

export const todoSet = defineOp(TodoModel, 'todo.set', {
  apply: (s, p: TodoSetPayload): TodoModelState => (p.todos === s ? s : p.todos),
});
