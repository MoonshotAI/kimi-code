/**
 * `todo` domain (L4) — task item data shape and pure render helpers.
 *
 * `TodoItem` / `TodoStatus` are the persistent shape carried by the
 * `tools.update_store` (`key: 'todo'`) wire record and rendered by the
 * `TodoListTool` and the stale reminder. Items form a tree via
 * `parentId` references — flat storage, tree rendering.
 *
 * Backward compatibility: old items without `id`/`parentId` are
 * auto-migrated (assigned `T1`, `T2`, … with `parentId: null`), and
 * the legacy `'pending'` status maps to `'open'`.
 *
 * Pure and scope-less — no scoped state lives here. The session todo
 * list itself is owned by `ISessionTodoService`.
 */

export const TODO_LIST_TOOL_NAME = 'TodoList' as const;

export type TodoStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'abandoned';

export interface TodoItem {
  readonly id: string;
  readonly parentId: string | null;
  readonly title: string;
  readonly status: TodoStatus;
  readonly description?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Sanitize unknown wire data into a valid readonly TodoItem[].
 * Migrates old format (no id/parentId, 'pending' status) to the new
 * tree-shaped format.
 */
export function readTodoItems(raw: unknown): readonly TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  const migrated: TodoItem[] = [];
  let counter = 0;

  for (const item of raw) {
    if (!isRawTodoItem(item)) continue;
    counter += 1;

    const id = typeof item['id'] === 'string' && item['id'] ? item['id'] : `T${counter}`;
    const parentId =
      typeof item['parentId'] === 'string' && item['parentId']
        ? item['parentId']
        : null;
    const status = normalizeStatus(item['status']);
    const title = String(item['title']);
    const description =
      typeof item['description'] === 'string' ? item['description'] : undefined;
    const createdAt =
      typeof item['createdAt'] === 'number' ? item['createdAt'] : now;
    const updatedAt =
      typeof item['updatedAt'] === 'number' ? item['updatedAt'] : now;

    migrated.push({ id, parentId, title, status, description, createdAt, updatedAt });
  }

  return migrated;
}

function isRawTodoItem(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['title'] === 'string' && typeof record['status'] === 'string';
}

function normalizeStatus(value: unknown): TodoStatus {
  if (value === 'pending') return 'open'; // migrate old format
  if (
    value === 'open' ||
    value === 'in_progress' ||
    value === 'blocked' ||
    value === 'done' ||
    value === 'abandoned'
  ) {
    return value;
  }
  return 'open';
}

export function isTodoItem(value: unknown): value is TodoItem {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    (record['parentId'] === null || typeof record['parentId'] === 'string') &&
    typeof record['title'] === 'string' &&
    isTodoStatus(record['status'])
  );
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return (
    value === 'open' ||
    value === 'in_progress' ||
    value === 'blocked' ||
    value === 'done' ||
    value === 'abandoned'
  );
}

/**
 * Generate the next child ID for a given parent.
 * Top-level: T1, T2, T3, …
 * Children of T1: T1.1, T1.2, …
 * Children of T1.1: T1.1.1, T1.1.2, …
 */
export function nextChildId(
  parentId: string | null,
  siblings: readonly TodoItem[],
): string {
  const prefix = parentId ? `${parentId}.` : 'T';
  let max = 0;
  for (const s of siblings) {
    if (s.parentId !== parentId) continue;
    const suffix = parentId ? s.id.slice(parentId.length + 1) : s.id.slice(1);
    const num = parseInt(suffix, 10);
    if (!Number.isNaN(num) && num > max) max = num;
  }
  return `${prefix}${max + 1}`;
}

/**
 * Render the todo list as a tree with indentation.
 */
export function renderTodoList(
  todos: readonly TodoItem[],
  title = 'Current task list:',
): string {
  if (todos.length === 0) {
    return 'Todo list is empty.';
  }
  const children = new Map<string | null, TodoItem[]>();
  for (const t of todos) {
    const list = children.get(t.parentId) ?? [];
    list.push(t);
    children.set(t.parentId, list);
  }

  const lines: string[] = [title];
  const roots = children.get(null) ?? [];
  for (const root of roots) {
    renderTreeLine(root, children, 0, lines);
  }
  return lines.join('\n');
}

function renderTreeLine(
  item: TodoItem,
  children: Map<string | null, TodoItem[]>,
  depth: number,
  lines: string[],
): void {
  const indent = '  '.repeat(depth + 1);
  const marker = statusMarker(item.status);
  const desc = item.description ? ` — ${item.description}` : '';
  lines.push(`${indent}${marker} ${item.id}: ${item.title}${desc}`);

  const kids = children.get(item.id) ?? [];
  for (const kid of kids) {
    renderTreeLine(kid, children, depth + 1, lines);
  }
}

function statusMarker(status: TodoStatus): string {
  switch (status) {
    case 'open':
      return '[open]';
    case 'in_progress':
      return '[in_progress]';
    case 'blocked':
      return '[blocked]';
    case 'done':
      return '[done]';
    case 'abandoned':
      return '[abandoned]';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
