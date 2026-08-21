import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import { defineAgentCapability } from '#/agent/runtime/agentRuntime';

import type { TodoItem } from './todoItem';

export interface IAgentTodo {
  readonly _serviceBrand: undefined;
  get(): readonly TodoItem[];
  replace(todos: readonly TodoItem[]): Promise<void>;
  clear(): Promise<void>;
  readonly onDidChange: Event<readonly TodoItem[]>;
}

export const IAgentTodo = createDecorator<IAgentTodo>('agentTodo');

export const AgentTodo = defineAgentCapability<IAgentTodo>('todo');
