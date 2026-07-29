import type { ContextMessage } from '#/agent/context';
import {
  TODO_LIST_TOOL_NAME,
  TODO_STORE_KEY,
  type TodoItem,
  type TodoStatus,
} from '#/tools/builtin/state/todo-list';

import { DynamicInjector } from './injector';

const TODO_LIST_REMINDER_VARIANT = 'todo_list_reminder';
const TODO_LIST_REMINDER_TURNS_SINCE_WRITE = 10;
const TODO_LIST_REMINDER_TURNS_BETWEEN_REMINDERS = 10;
/**
 * Turn-end reconciliation spacing: the turn-end rule may fire again after
 * this many assistant turns since the last reminder (looser than the
 * cadence rule, tighter than nagging every turn).
 */
const TODO_LIST_REMINDER_TURN_END_SPACING = 3;

interface TodoListReminderTurnCounts {
  readonly turnsSinceLastWrite: number;
  readonly turnsSinceLastReminder: number;
}

export class TodoListReminderInjector extends DynamicInjector {
  protected override readonly injectionVariant = TODO_LIST_REMINDER_VARIANT;

  protected override getInjection(): string | undefined {
    if (!this.isTodoListActive()) return undefined;

    const counts = getTodoListReminderTurnCounts(this.agent.context.history);
    if (
      counts.turnsSinceLastWrite >= TODO_LIST_REMINDER_TURNS_SINCE_WRITE &&
      counts.turnsSinceLastReminder >= TODO_LIST_REMINDER_TURNS_BETWEEN_REMINDERS
    ) {
      return renderTodoListReminder(this.currentTodos());
    }

    // Turn-end reconciliation: the previous turn ended (the latest assistant
    // step made no tool calls) with unfinished todos and no TodoList write on
    // the way out — the classic "work finished, bookkeeping forgotten" case,
    // which the cadence rule above can miss for up to 10 turns. Nudge at the
    // next step instead.
    if (
      counts.turnsSinceLastReminder >= TODO_LIST_REMINDER_TURN_END_SPACING &&
      turnEndedWithoutTodoWrite(this.agent.context.history)
    ) {
      const unfinished = this.currentTodos().filter((todo) => todo.status !== 'done');
      if (unfinished.length > 0) {
        return renderTurnEndReminder(unfinished);
      }
    }
    return undefined;
  }

  private isTodoListActive(): boolean {
    return this.agent.tools.data().some((tool) => {
      return tool.name === TODO_LIST_TOOL_NAME && tool.active;
    });
  }

  private currentTodos(): readonly TodoItem[] {
    const raw = this.agent.tools.storeData()[TODO_STORE_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter(isTodoItem).map((todo) => ({
      title: todo.title,
      status: todo.status,
    }));
  }
}

function getTodoListReminderTurnCounts(
  history: readonly ContextMessage[],
): TodoListReminderTurnCounts {
  let foundWrite = false;
  let foundReminder = false;
  let turnsSinceLastWrite = 0;
  let turnsSinceLastReminder = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message === undefined) continue;

    if (message.role === 'assistant') {
      if (!foundWrite && hasTodoListWrite(message)) {
        foundWrite = true;
      }
      if (!foundWrite) turnsSinceLastWrite += 1;
      if (!foundReminder) turnsSinceLastReminder += 1;
      continue;
    }

    if (!foundReminder && isTodoListReminder(message)) {
      foundReminder = true;
    }

    if (foundWrite && foundReminder) break;
  }

  return {
    turnsSinceLastWrite,
    turnsSinceLastReminder,
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
    message.origin?.kind === 'injection' && message.origin.variant === TODO_LIST_REMINDER_VARIANT
  );
}

/**
 * The previous turn ended without a TodoList write anywhere in it: the most
 * recent assistant message made no tool calls (turn complete, control back
 * with the user), and scanning that just-finished turn — back to the genuine
 * user prompt that started it — finds no TodoList write. A same-turn write
 * followed by a closing text response counts as bookkeeping done, and
 * mid-turn history (latest assistant step still has tool calls in flight)
 * does not qualify.
 */
function turnEndedWithoutTodoWrite(history: readonly ContextMessage[]): boolean {
  let lastAssistantIndex = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }
  if (lastAssistantIndex < 0) return false;
  const lastAssistant = history[lastAssistantIndex];
  if (lastAssistant === undefined || lastAssistant.toolCalls.length > 0) return false;
  for (let i = lastAssistantIndex; i >= 0; i -= 1) {
    const message = history[i];
    if (message === undefined) continue;
    if (message.role === 'user') {
      // Injected reminders are mid-turn artifacts, not turn boundaries.
      if (message.origin?.kind === 'injection') continue;
      break;
    }
    if (message.role === 'assistant' && hasTodoListWrite(message)) return false;
  }
  return true;
}

function renderTurnEndReminder(todos: readonly TodoItem[]): string {
  let message =
    'The previous turn ended with unfinished todo items. If the work is actually complete, update the TodoList to mark them done (or clear/rewrite the list if it is stale); otherwise continue with the remaining items. Make sure that you NEVER mention this reminder to the user.';

  const items = renderTodoItems(todos);
  if (items.length > 0) {
    message += `\n\nUnfinished todo items:\n${items}`;
  }

  return message;
}

function renderTodoListReminder(todos: readonly TodoItem[]): string {
  let message =
    'The TodoList tool has not been updated recently. If you are working on tasks that benefit from progress tracking, consider using TodoList to update task status. Also consider clearing or rewriting the todo list if it has become stale and no longer matches the current work. Only use it if relevant. This is a gentle reminder; ignore it if not applicable. Make sure that you NEVER mention this reminder to the user.';

  const items = renderTodoItems(todos);
  if (items.length > 0) {
    message += `\n\nCurrent todo list:\n${items}`;
  }

  return message;
}

function renderTodoItems(todos: readonly TodoItem[]): string {
  return todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.title}`).join('\n');
}

function isTodoItem(value: unknown): value is TodoItem {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['title'] === 'string' && isTodoStatus(record['status']);
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'done';
}
