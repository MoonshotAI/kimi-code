import type { AgentEventStore } from '#/agent/slices';
import { createUserMessage } from '#/llm/message';
import type { Plugin } from '#/plugin';

import { readTodoState } from './slice';
import { createTodoListTool } from './tool';
import { renderTodoList } from './todoItem';

const STALE_TURNS = 2;

export interface TodoPlugin extends Plugin {
  readonly name: 'todo';
}

export function createTodoPlugin(store: AgentEventStore): TodoPlugin {
  const tool = createTodoListTool(store);
  return {
    name: 'todo',
    tools: () => [tool],
    connect(target) {
      if (target.kind !== 'agent') return;
      target.on('turn.started', (event) => {
        if (event.type !== 'turn.started') return;
        const { todos, currentTurn, lastWriteTurn } = readTodoState(store);
        if (todos.length === 0) return;
        if (todos.every((todo) => todo.status === 'done')) return;
        if (currentTurn - lastWriteTurn !== STALE_TURNS) return;
        target.notify(
          createUserMessage(
            `<system-reminder>\nThe todo list has not been updated recently. If the work is still in progress, update the list to reflect the current progress.\n${renderTodoList(todos)}\n</system-reminder>`,
          ),
        );
      });
    },
  };
}
