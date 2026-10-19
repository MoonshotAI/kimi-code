import type { ContextMessage } from '#/agent/contextMemory/types';

import { TODO_LIST_TOOL_NAME, todoProgress, type TodoItem } from './todoItem';

export const TODO_LIST_REMINDER_VARIANT = 'todo_list_reminder';

const TODO_LIST_REMINDER_STEPS_SINCE_WRITE = 5;
const TODO_LIST_REMINDER_STEPS_BETWEEN_REMINDERS = 5;

interface TodoListReminderInput {
  readonly active: boolean;
  readonly history: readonly ContextMessage[];
  readonly todos: readonly TodoItem[];
}

export interface TodoListStaleReminder {
  readonly text: string;
  readonly stepsSinceLastWrite: number;
}

export interface TodoListWriteStats {
  readonly stepsSinceLastWrite?: number;
  readonly remindedSinceLastWrite: boolean;
}

interface TodoListReminderStepCounts {
  readonly stepsSinceLastWrite: number;
  readonly stepsSinceLastReminder: number;
}

export function todoListStaleReminder(
  input: TodoListReminderInput,
): TodoListStaleReminder | undefined {
  if (!input.active) return undefined;
  if (todoProgress(input.todos).open === 0) return undefined;

  const counts = getTodoListReminderStepCounts(input.history);
  if (
    counts.stepsSinceLastWrite < TODO_LIST_REMINDER_STEPS_SINCE_WRITE ||
    counts.stepsSinceLastReminder < TODO_LIST_REMINDER_STEPS_BETWEEN_REMINDERS
  ) {
    return undefined;
  }

  return {
    text: renderTodoListReminder(input.todos, counts.stepsSinceLastWrite),
    stepsSinceLastWrite: counts.stepsSinceLastWrite,
  };
}

export function todoListWriteStatsBefore(
  history: readonly ContextMessage[],
  toolCallId: string,
): TodoListWriteStats {
  const end = history.findLastIndex(
    (message) =>
      message.role === 'assistant' && message.toolCalls.some((call) => call.id === toolCallId),
  );
  let steps = 0;
  let reminded = false;
  for (let i = (end === -1 ? history.length : end) - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message === undefined) continue;

    if (message.role === 'assistant') {
      if (hasTodoListWrite(message)) {
        return { stepsSinceLastWrite: steps, remindedSinceLastWrite: reminded };
      }
      steps += 1;
      continue;
    }

    if (isTodoListReminder(message)) reminded = true;
  }
  return { remindedSinceLastWrite: reminded };
}

function getTodoListReminderStepCounts(
  history: readonly ContextMessage[],
): TodoListReminderStepCounts {
  let foundWrite = false;
  let foundReminder = false;
  let stepsSinceLastWrite = 0;
  let stepsSinceLastReminder = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message === undefined) continue;

    if (message.role === 'assistant') {
      if (!foundWrite && hasTodoListWrite(message)) {
        foundWrite = true;
      }
      if (!foundWrite) stepsSinceLastWrite += 1;
      if (!foundReminder) stepsSinceLastReminder += 1;
      continue;
    }

    if (!foundReminder && isTodoListReminder(message)) {
      foundReminder = true;
    }

    if (foundWrite && foundReminder) break;
  }

  return {
    stepsSinceLastWrite,
    stepsSinceLastReminder,
  };
}

function hasTodoListWrite(message: ContextMessage): boolean {
  return message.toolCalls.some((toolCall) => {
    if (toolCall.name !== TODO_LIST_TOOL_NAME) return false;
    if (typeof toolCall.arguments !== 'string') return false;

    try {
      const args = JSON.parse(toolCall.arguments) as { todos?: unknown };
      return Array.isArray(args.todos);
    } catch {
      return false;
    }
  });
}

function isTodoListReminder(message: ContextMessage): boolean {
  return (
    message.origin?.kind === 'injection' &&
    message.origin.variant === TODO_LIST_REMINDER_VARIANT
  );
}

function renderTodoListReminder(todos: readonly TodoItem[], stepsSinceLastWrite: number): string {
  const { done, inProgress } = todoProgress(todos);
  const [current] = inProgress;
  const progress = `${String(done)}/${String(todos.length)} done`;
  const status =
    current === undefined
      ? `${progress}, none in_progress`
      : `${progress}, "${current.title}" still in_progress`;
  return [
    `The todo list has not been updated in the last ${String(stepsSinceLastWrite)} steps (${status}). If an item is finished, mark it done now; the TodoList call can go in the same response as your next tool call. If the list no longer matches the current work, rewrite or clear it. Never mention this reminder to the user.`,
    '',
    'Current todo list:',
    renderTodoItems(todos),
  ].join('\n');
}

function renderTodoItems(todos: readonly TodoItem[]): string {
  return todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.title}`).join('\n');
}
