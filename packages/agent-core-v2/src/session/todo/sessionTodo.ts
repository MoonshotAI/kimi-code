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
