/**
 * `todo` domain (L4) — `ISessionTodoService` contract.
 *
 * The session-shared todo list: an in-memory list materialized from the main
 * agent's `tools.update_store` (`key: 'todo'`) wire records, mutated through
 * `setTodos` (which appends a fresh `tools.update_store` to the main agent's
 * wire), and readable by every agent in the session. Bound at Session scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { TodoItem } from './todoItem';

export interface ISessionTodoService {
  readonly _serviceBrand: undefined;

  getTodos(): readonly TodoItem[];
  setTodos(todos: readonly TodoItem[]): void;
  clear(): void;
  readonly onDidChange: Event<readonly TodoItem[]>;
}

export const ISessionTodoService = createDecorator<ISessionTodoService>('sessionTodoService');
