import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { AgentContext } from '#/agent/agentContext/agentContext';

import type { TodoItem } from './todoItem';

export interface TodoChange {
  readonly agent: AgentContext;
  readonly todos: readonly TodoItem[];
}

export interface ISessionTodoService {
  readonly _serviceBrand: undefined;

  getTodos(agent: AgentContext): Promise<readonly TodoItem[]>;
  setTodos(agent: AgentContext, todos: readonly TodoItem[]): Promise<void>;
  clear(agent: AgentContext): Promise<void>;
  readonly onDidChange: Event<TodoChange>;
}

export const ISessionTodoService = createDecorator<ISessionTodoService>('sessionTodoService');
