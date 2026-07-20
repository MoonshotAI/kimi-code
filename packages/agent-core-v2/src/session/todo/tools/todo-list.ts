/**
 * `todo` domain (L4) — `TodoListTool`, the structured TODO list tool.
 *
 * A single tool serves both reads and writes:
 *
 *   - `resolveExecution({ todos: [...] })` — replace the full list
 *   - `resolveExecution({ todos: [] })`    — clear the list
 *   - `resolveExecution({})`               — query the current list
 *
 * The list is session-shared: the tool reads/writes `ISessionTodoService`,
 * which persists every change as a `tools.update_store` (`key: 'todo'`) wire record on the main agent.
 * Self-registers via `registerTool(TodoListTool)` at module load; the Eager
 * `AgentBuiltinToolsRegistrar` instantiates one per agent (resolving the
 * Session-scope `ISessionTodoService` from the parent scope) and registers it
 * into that agent's tool registry — never from a service constructor, which
 * would re-enter `ISessionTodoService` while it is still being constructed.
 */

import { z } from 'zod';

import type { BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';

import { ISessionTodoService } from '#/session/todo/sessionTodo';
import {
  TODO_LIST_TOOL_NAME,
  renderTodoList,
  type TodoItem,
  type TodoStatus,
} from '#/session/todo/todoItem';

import DESCRIPTION from './todo-list.md?raw';
import TODO_LIST_WRITE_REMINDER from './todo-list-write-reminder.md?raw';

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

export class TodoListTool implements BuiltinTool<TodoListInput> {
  readonly name = TODO_LIST_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TodoListInputSchema);

  constructor(@ISessionTodoService private readonly todo: ISessionTodoService) {}

  resolveExecution(args: TodoListInput): ToolExecution {
    const description =
      args.todos === undefined
        ? 'Reading todo list'
        : args.todos.length === 0
          ? 'Clearing todo list'
          : 'Updating todo list';
    return {
      description,
      approvalRule: this.name,
      execute: async () => {
        if (args.todos === undefined) {
          return { isError: false, output: renderTodoList(this.todo.getTodos()) };
        }

        const next: readonly TodoItem[] = args.todos.map((todo) => ({
          title: todo.title,
          status: todo.status,
        }));
        this.todo.setTodos(next);
        const stored = this.todo.getTodos();
        const output =
          stored.length === 0
            ? 'Todo list cleared.'
            : `Todo list updated.\n${renderTodoList(stored)}\n\n${TODO_LIST_WRITE_REMINDER.trim()}`;
        return { isError: false, output };
      },
    };
  }
}

registerTool(TodoListTool);
