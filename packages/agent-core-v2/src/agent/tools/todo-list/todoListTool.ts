import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';

import {
  agentContextOfScope,
  IAgentScopeContext,
} from '#/agent/scopeContext/scopeContext';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import {
  TODO_LIST_TOOL_NAME,
  renderTodoList,
  type TodoItem,
} from '#/session/todo/todoItem';

import {
  ITodoListTool,
  TodoListInputSchema,
  type TodoListInput,
} from './todo-list';
import DESCRIPTION from './todo-list.md?raw';
import TODO_LIST_WRITE_REMINDER from './todo-list-write-reminder.md?raw';

export class TodoListTool implements ITodoListTool {
  declare readonly _serviceBrand: undefined;
  readonly name = TODO_LIST_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TodoListInputSchema);

  constructor(
    @ISessionTodoService private readonly todo: ISessionTodoService,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
  ) {}

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
        const agent = agentContextOfScope(this.agent);
        if (args.todos === undefined) {
          const todos = await this.todo.getTodos(agent);
          return { isError: false, output: renderTodoList(todos) };
        }

        const next: readonly TodoItem[] = args.todos.map((todo) => ({
          title: todo.title,
          status: todo.status,
        }));
        await this.todo.setTodos(agent, next);
        const stored = await this.todo.getTodos(agent);
        const output =
          stored.length === 0
            ? 'Todo list cleared.'
            : `Todo list updated.\n${renderTodoList(stored)}\n\n${TODO_LIST_WRITE_REMINDER.trim()}`;
        return { isError: false, output };
      },
    };
  }
}
