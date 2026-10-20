import { createFeature, useAgent } from '@moonshot-ai/agent-core/app/index';
import { createHistoryMessageBuilder } from '@moonshot-ai/agent-core/history/index';
import { computed, createFacadeToken, useExpose, type ComputedRef } from '@moonshot-ai/agent-core/kernel/index';

import { useAgentTools, useFeatureStore, useLoopEvent } from '#/runtime/index';

import { todos, type TodoEvent, type TodoState } from './projection';
import { createTodoListTool } from './tool';
import { renderTodoList, type TodoItem } from './todoItem';

const STALE_TURNS = 2;

export interface TodoFace {
  readonly items: ComputedRef<readonly TodoItem[]>;
  readonly state: ComputedRef<TodoState>;
}

export const TodoRef = createFacadeToken<TodoFace>('todo');

export const todo = createFeature<TodoEvent>('todo', {
  agent() {
    const store = useFeatureStore('agent', 'todo', todos);
    useAgentTools(createTodoListTool(store));
    const agent = useAgent();
    useLoopEvent('turn.started', ({ turnId }) => {
      const current = store.state.value;
      if (current.todos.length === 0) return;
      if (current.todos.every((item) => item.status === 'done')) return;
      if (turnId - current.lastWriteTurnId !== STALE_TURNS) return;
      const message = createHistoryMessageBuilder()
        .systemReminder(
          `The todo list has not been updated recently. If the work is still in progress, update the list to reflect the current progress.\n${renderTodoList(current.todos)}`,
        )
        .userMessage();
      queueMicrotask(() => {
        agent.loop.remind({ message, meta: { key: 'todo-stale' } });
      });
    });
    useExpose(TodoRef, {
      items: computed(() => store.state.value.todos),
      state: store.state,
    });
  },
});
