import {
  createFeature,
  createHistoryMessageBuilder,
  useAgent,
  useAgentStore,
  useAgentTools,
} from '@moonshot-ai/agent-core';
import { computed, createToken, useExpose, type Ref } from '@moonshot-ai/agent-core/kernel/index';

import { todos, type TodoState } from './projection';
import { createTodoListTool } from './tool';
import { renderTodoList, type TodoItem } from './todoItem';

const STALE_TURNS = 2;

export interface TodoFace {
  readonly items: Ref<readonly TodoItem[]>;
  readonly state: Ref<TodoState>;
}

export const TodoRef = createToken<TodoFace>('todo');

export const todo = createFeature('todo', {
  agent() {
    const store = useAgentStore();
    const state = store.fold(todos);
    const agent = useAgent();
    useAgentTools(createTodoListTool(store, state));
    agent.on('turn.started', () => {
      const current = state.value;
      if (current.todos.length === 0) return;
      if (current.todos.every((item) => item.status === 'done')) return;
      if (current.currentTurn - current.lastWriteTurn !== STALE_TURNS) return;
      agent.notify(
        createHistoryMessageBuilder()
          .systemReminder(
            `The todo list has not been updated recently. If the work is still in progress, update the list to reflect the current progress.\n${renderTodoList(current.todos)}`,
          )
          .userMessage(),
      );
    });
    useExpose(TodoRef, {
      items: computed(() => state.value.todos),
      state,
    });
  },
});
