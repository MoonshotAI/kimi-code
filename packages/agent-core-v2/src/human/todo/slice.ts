import { createSlice } from '#/eventStore/slice';

import type { StateUpdated, TurnStarted } from '#/agent/events';

import { readTodoItems, type TodoItem } from './todoItem';

export interface TodoSliceState {
  todos: readonly TodoItem[];
  currentTurn: number;
  lastWriteTurn: number;
}

export function readTodoState(store: { slice(name: string): unknown }): TodoSliceState {
  const state = store.slice('todo') as TodoSliceState | undefined;
  return state ?? { todos: [], currentTurn: 0, lastWriteTurn: 0 };
}

export const todoSlice = createSlice({
  name: 'todo',
  initialState: (): TodoSliceState => ({ todos: [], currentTurn: 0, lastWriteTurn: 0 }),
  reducers: {
    'state.updated': (draft, event: StateUpdated) => {
      if (event.name !== 'todo') return;
      const value = event.value as { todos?: unknown; lastWriteTurn?: unknown };
      draft.todos = readTodoItems(value.todos);
      if (typeof value.lastWriteTurn === 'number') {
        draft.lastWriteTurn = value.lastWriteTurn;
      }
    },
    'turn.started': (draft, _event: TurnStarted) => {
      draft.currentTurn += 1;
    },
  },
});
