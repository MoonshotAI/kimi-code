import { readTodoItems, type TodoItem } from './todoItem';

export interface TodoState {
  todos: readonly TodoItem[];
  currentTurn: number;
  lastWriteTurn: number;
}

export function createTodoState(): TodoState {
  return { todos: [], currentTurn: 0, lastWriteTurn: 0 };
}

export interface PersistedTodoState {
  todos: readonly TodoItem[];
  lastWriteTurn: number;
}

export function snapshotTodoState(state: TodoState): PersistedTodoState {
  return { todos: state.todos, lastWriteTurn: state.lastWriteTurn };
}

export function restoreTodoState(value: unknown, currentTurn: number): TodoState {
  const state = createTodoState();
  state.currentTurn = currentTurn;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    state.todos = readTodoItems(record['todos']);
    if (typeof record['lastWriteTurn'] === 'number') {
      state.lastWriteTurn = record['lastWriteTurn'];
    }
  }
  return state;
}
