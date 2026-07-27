/**
 * `tools` domain (L7) — `ITodoListTool` contract (the `TodoList` tool).
 *
 * Public contract of the structured TODO list tool. A single input schema
 * serves both reads and writes:
 *
 *   - `{ todos: [...] }` — replace the full list
 *   - `{ todos: [] }`    — clear the list
 *   - `{}`               — query the current list
 *
 * Exports the model-facing `TodoListInputSchema` / `TodoListInput` and the
 * `ITodoListTool` DI decorator that the implementation (`todoListTool.ts`)
 * registers against via `registerAgentToolService`. The tool name and item types
 * stay with the `todo` domain (`TODO_LIST_TOOL_NAME`, `TodoItem`,
 * `TodoStatus`). Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';
import { type TodoStatus } from '#/session/todo/todoItem';

const TodoItemSchema = z.object({
  title: z.string().min(1).describe('Short, actionable title for the todo.'),
  status: z.enum(['pending', 'in_progress', 'done']).describe('Current status of the todo.'),
});

export interface TodoListInput {
  todos?: Array<{ title: string; status: TodoStatus }>;
}

export const TodoListInputSchema: z.ZodType<TodoListInput> = z.object({
  todos: z
    .array(TodoItemSchema)
    .optional()
    .describe(
      'The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.',
    ),
});

export interface ITodoListTool extends AgentTool<TodoListInput> {
  readonly _serviceBrand: undefined;
}
export const ITodoListTool = createDecorator<ITodoListTool>('todoListTool');
