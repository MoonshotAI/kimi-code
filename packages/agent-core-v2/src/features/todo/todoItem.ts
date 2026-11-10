export const TODO_LIST_TOOL_NAME = 'TodoList' as const;

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

export function readTodoItems(raw: unknown): readonly TodoItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isTodoItem).map((todo) => ({
    title: todo.title,
    status: todo.status,
  }));
}

export function isTodoItem(value: unknown): value is TodoItem {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['title'] === 'string' && isTodoStatus(record['status']);
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'done';
}

export interface TodoProgress {
  readonly total: number;
  readonly done: number;
  readonly open: number;
  readonly inProgress: readonly TodoItem[];
}

export function todoProgress(todos: readonly TodoItem[]): TodoProgress {
  const done = todos.filter((todo) => todo.status === 'done').length;
  return {
    total: todos.length,
    done,
    open: todos.length - done,
    inProgress: todos.filter((todo) => todo.status === 'in_progress'),
  };
}

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
