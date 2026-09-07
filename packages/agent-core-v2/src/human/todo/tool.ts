import { defineTool, type ToolDefinition } from '#/tool/tool';

import type { TodoState } from './state';
import { readTodoItems, renderTodoList, TODO_LIST_TOOL_NAME } from './todoItem';
import DESCRIPTION from './todo-list.md?raw';
import TODO_LIST_WRITE_REMINDER from './todo-list-write-reminder.md?raw';

export function createTodoListTool(state: TodoState): ToolDefinition {
  return defineTool({
    name: TODO_LIST_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description:
            'The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short, actionable title for the todo.' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'done'],
                description: 'Current status of the todo.',
              },
            },
            required: ['title', 'status'],
          },
        },
      },
    },
    async execute({ toolCall }) {
      const args = JSON.parse(toolCall.arguments ?? '{}') as { todos?: unknown };
      if (args.todos === undefined) {
        return { content: [{ type: 'text', text: renderTodoList(state.todos) }] };
      }
      const next = readTodoItems(args.todos);
      state.todos = next;
      state.lastWriteTurn = state.currentTurn;
      if (next.length === 0) {
        return { content: [{ type: 'text', text: 'Todo list cleared.' }] };
      }
      return {
        content: [
          {
            type: 'text',
            text: `Todo list updated.\n${renderTodoList(next)}\n\n${TODO_LIST_WRITE_REMINDER.trim()}`,
          },
        ],
      };
    },
  });
}
