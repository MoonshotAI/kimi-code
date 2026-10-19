import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { TodoListWrittenEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';

import {
  IAgentTodoService,
} from '#/features/todo/todoService';
import {
  TODO_LIST_TOOL_NAME,
  renderTodoList,
  todoProgress,
  type TodoItem,
  type TodoProgress,
} from '#/features/todo/todoItem';
import { todoListWriteStatsBefore } from '#/features/todo/todoListReminder';

import {
  ITodoListTool,
  TodoListInputSchema,
  type TodoListInput,
} from './todo-list';
import DESCRIPTION from './todo-list.md?raw';

export class TodoListTool implements ITodoListTool {
  declare readonly _serviceBrand: undefined;
  readonly name = TODO_LIST_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TodoListInputSchema);

  constructor(
    @IAgentTodoService private readonly todo: IAgentTodoService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
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
      display: {
        kind: 'todo_list',
        items: (args.todos ?? this.todo.get()).map((todo) => ({ ...todo })),
      },
      approvalRule: this.name,
      execute: async ({ turnId, toolCallId }) => {
        if (args.todos === undefined) {
          return { isError: false, output: renderTodoList(this.todo.get()) };
        }

        const next: readonly TodoItem[] = args.todos.map((todo) => ({
          title: todo.title,
          status: todo.status,
        }));
        await this.todo.replace(next);
        const stored = this.todo.get();
        const progress = todoProgress(stored);
        const stats = todoListWriteStatsBefore(this.context.get(), toolCallId);
        const properties: TodoListWrittenEvent = {
          turn_id: turnId,
          item_count: progress.total,
          open_count: progress.open,
          steps_since_write: stats.stepsSinceLastWrite,
          after_reminder: stats.remindedSinceLastWrite,
        };
        this.telemetry.track2('todo_list_written', properties);
        if (stored.length === 0) return { isError: false, output: 'Todo list cleared.' };
        const updated = `Todo list updated.\n${renderTodoList(stored)}`;
        const hint = nextStepHint(progress);
        return { isError: false, output: hint === undefined ? updated : `${updated}\n\n${hint}` };
      },
    };
  }
}

function nextStepHint(progress: TodoProgress): string | undefined {
  if (progress.open === 0) return undefined;
  const [current, ...others] = progress.inProgress;
  if (current === undefined) {
    return 'No item is in_progress. Mark the one you are working on as in_progress.';
  }
  if (others.length > 0) {
    return 'Several items are in_progress. Keep only the one you are working on now in_progress.';
  }
  if (progress.open === 1) {
    return `"${current.title}" is the last open item. Once it is finished, mark it done before you write your final message; if it stays blocked or unfinished, keep it in_progress and say what remains in your reply.`;
  }
  return `When "${current.title}" is finished, mark it done and set the next item in_progress; that update can go in the same response as your next tool call.`;
}
