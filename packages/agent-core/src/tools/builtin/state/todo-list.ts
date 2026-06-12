/**
 * TodoListTool — structured TODO list management tool.
 *
 * The LLM uses this tool to maintain a visible plan of sub-tasks during
 * plan-mode workflows and multi-step operations. A single tool serves
 * both reads and writes:
 *
 *   - `resolveExecution({ todos: [...] })` — replace the full list
 *   - `resolveExecution({ todos: [] })`    — clear the list
 *   - `resolveExecution({})`               — query current list (no mutation)
 *
 * Storage: todos live in the agent-level tool store. Writes go through
 * `tools.update_store`, so the store update is visible on wire replay.
 */

import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import type { ToolStore } from '../../store';
import DESCRIPTION from './todo-list.md?raw';

// ── TODO state shape ─────────────────────────────────────────────────

export const TODO_LIST_TOOL_NAME = 'TodoList' as const;
export const TODO_STORE_KEY = 'todo';
const TODO_LIST_WRITE_REMINDER =
  'Ensure that you continue to use the todo list to track progress. Mark tasks done immediately after finishing them, and keep exactly one task in_progress when work is underway.';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

declare module '../../store' {
  interface ToolStoreData {
    todo: readonly TodoItem[];
  }
}

// ── Schema ───────────────────────────────────────────────────────────

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

// ── Implementation ───────────────────────────────────────────────────

export function renderTodoList(todos: readonly TodoItem[], title = 'Current todo list:'): string {
  if (todos.length === 0) {
    return 'Todo list is empty.';
  }
  const lines = todos.map((t) => {
    const marker = statusMarker(t.status);
    return `  ${marker} ${t.title}`;
  });
  return [title, ...lines].join('\n');
}

function statusMarker(status: TodoStatus): string {
  switch (status) {
    case 'pending':
      return '[pending]';
    case 'in_progress':
      return '[in_progress]';
    case 'done':
      return '[done]';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export class TodoListTool implements BuiltinTool<TodoListInput> {
  readonly name = TODO_LIST_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TodoListInputSchema);

  constructor(private readonly store: ToolStore) {}

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
        // Query mode — return the current list without mutation.
        if (args.todos === undefined) {
          const current = this.getTodos();
          return { isError: false, output: renderTodoList(current) };
        }

        // Write mode — replace the full list and return the new state.
        this.setTodos(args.todos);
        const stored = this.getTodos();
        const output =
          stored.length === 0
            ? 'Todo list cleared.'
            : `Todo list updated.\n${renderTodoList(stored)}\n\n${TODO_LIST_WRITE_REMINDER}`;
        return { isError: false, output };
      },
    };
  }

  private getTodos(): readonly TodoItem[] {
    const todos = this.store.get(TODO_STORE_KEY);
    return todos ?? [];
  }

  private setTodos(todos: readonly TodoItem[]): void {
    this.store.set(
      TODO_STORE_KEY,
      todos.map((todo) => ({ title: todo.title, status: todo.status })),
    );
  }
}
