import type { BranchRef, Projection, RecordEvent } from '@moonshot-ai/agent-core';

import { readTodoItems, type TodoItem } from './todoItem';

export const TODO_UPDATED = 'todo.updated';

export interface TodoState {
  readonly todos: readonly TodoItem[];
  readonly currentTurn: number;
  readonly lastWriteTurn: number;
}

export const todos: Projection<TodoState, RecordEvent, BranchRef> = {
  initial: () => ({ todos: [], currentTurn: 0, lastWriteTurn: 0 }),
  reduce: (state, event) => {
    if (event.type === TODO_UPDATED) {
      return {
        todos: readTodoItems(event['todos']),
        currentTurn: state.currentTurn,
        lastWriteTurn:
          typeof event['lastWriteTurn'] === 'number' ? event['lastWriteTurn'] : state.lastWriteTurn,
      };
    }
    if (event.type === 'turn.started') {
      return { ...state, currentTurn: state.currentTurn + 1 };
    }
    return state;
  },
};
