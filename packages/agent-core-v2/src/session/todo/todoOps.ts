/**
 * `todo` domain (L4) — replayable wire state for the shared todo list.
 *
 * Owns validated todo state consumed by the Session-scoped
 * `SessionTodoService` and keeps it consistent with conversation undo.
 */

import { z } from 'zod';

import { isRealUserInput } from '#/agent/contextMemory/compactionHandoff';
import { defineModel } from '#/wire/model';

import { readTodoItems, type TodoItem } from './todoItem';

export interface TodoModelState {
  readonly current: readonly TodoItem[];
  readonly checkpoints: readonly (readonly TodoItem[])[];
}

export const TodoModel = defineModel<TodoModelState>('todo', () => ({ current: [], checkpoints: [] }), {
  reducers: {
    'context.append_message': (state, { message }) =>
      isRealUserInput(message)
        ? { ...state, checkpoints: [...state.checkpoints, state.current] }
        : state,
    'context.apply_compaction': (state) =>
      state.checkpoints.length === 0 ? state : { ...state, checkpoints: [] },
    'context.clear': (state) =>
      state.checkpoints.length === 0 ? state : { ...state, checkpoints: [] },
    'context.undo': (state, { count }) => {
      if (count <= 0 || state.checkpoints.length < count) return state;
      const checkpointIndex = state.checkpoints.length - count;
      return {
        current: state.checkpoints[checkpointIndex]!,
        checkpoints: state.checkpoints.slice(0, checkpointIndex),
      };
    },
  },
});

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
