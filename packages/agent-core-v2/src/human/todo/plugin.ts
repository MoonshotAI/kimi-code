import { createUserMessage } from '#/llm/message';
import type { Plugin } from '#/plugin';

import { createTodoState, type TodoState } from './state';
import { createTodoListTool } from './tool';
import { renderTodoList } from './todoItem';

const STALE_TURNS = 2;

export interface TodoPlugin extends Plugin {
  readonly name: 'todo';
  readonly state: TodoState;
}

export function createTodoPlugin(state: TodoState = createTodoState()): TodoPlugin {
  const tool = createTodoListTool(state);
  return {
    name: 'todo',
    state,
    tools: () => [tool],
    connect(target) {
      if (target.kind !== 'agent') return;
      target.on('turn.start', (event) => {
        if (event.type !== 'turn.start') return;
        state.currentTurn += 1;
        if (state.todos.length === 0) return;
        if (state.todos.every((todo) => todo.status === 'done')) return;
        if (state.currentTurn - state.lastWriteTurn !== STALE_TURNS) return;
        target.notify(
          createUserMessage(
            `<system-reminder>\nThe todo list has not been updated recently. If the work is still in progress, update the list to reflect the current progress.\n${renderTodoList(state.todos)}\n</system-reminder>`,
          ),
        );
      });
    },
  };
}
