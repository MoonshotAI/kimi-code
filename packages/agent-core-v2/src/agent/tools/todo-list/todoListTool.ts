import type { ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';

import { SPINE_FLAG_ID } from '#/agent/spine/flag';
import { IFlagService } from '#/app/flag/flag';
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

// While the spine experiment runs, the model manages task progress through the
// spine tree instead, so the flat TodoList tool steps aside: two parallel
// progress trackers (flat list + tree) would drift apart and confuse the
// model. `when` is evaluated per Agent activation, which happens after the CLI
// `main()` process env is settled, so `KIMI_CODE_SPINE` toggles take effect for
// every new agent.
registerAgentToolService(ITodoListTool, TodoListTool, {
  name: 'TodoList',
  domain: 'todo',
  when: (accessor) => !accessor.get(IFlagService).enabled(SPINE_FLAG_ID),
});
