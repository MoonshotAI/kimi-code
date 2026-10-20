import type { Projection } from '@moonshot-ai/agent-core/store/index';

import type { FeatureEvent } from '#/runtime/index';

import { readTodoItems, type TodoItem } from './todoItem';

export const TODO_UPDATED = 'todo.updated' as const;

export interface TodoUpdatedEvent extends FeatureEvent {
  readonly type: typeof TODO_UPDATED;
  readonly todos: readonly TodoItem[];
}

export type TodoEvent = TodoUpdatedEvent;

export interface TodoState {
  readonly todos: readonly TodoItem[];
  readonly lastWriteTurnId: number;
}

export const todos: Projection<TodoState, TodoEvent> = {
  initial: () => ({ todos: [], lastWriteTurnId: 0 }),
  reduce: (state, entry) => {
    const { event } = entry;
    if (event.type !== TODO_UPDATED) return state;
    return {
      todos: readTodoItems(event.todos),
      lastWriteTurnId: event.turnId ?? state.lastWriteTurnId,
    };
  },
};
