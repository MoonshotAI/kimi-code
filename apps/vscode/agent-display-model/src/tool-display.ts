import type { DisplayBlock, DisplayTodoItem, DisplayTodoStatus, DisplayToolCallPart } from './model';

const TODO_KEYS = ['items', 'entries', 'todos', 'todo', 'list', 'todo_list', 'raw', 'output', 'message'] as const;
const GENERIC_SUMMARY_KEYS = ['query', 'pattern', 'regex', 'path', 'file', 'directory', 'root', 'cwd', 'command', 'cmd', 'description', 'raw'] as const;

export type DisplayToolKind = 'shell' | 'read-file' | 'write-file' | 'replace-file' | 'glob' | 'todo' | 'task' | 'generic';

interface ToolCallLike {
  name: string;
  argumentsText?: string | null;
  resultText?: string;
  displayBlocks?: DisplayBlock[];
}

export function parseToolArguments(argumentsText?: string | null): Record<string, unknown> {
  if (!argumentsText) {
    return {};
  }

  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { raw: argumentsText };
  } catch {
    return { raw: argumentsText };
  }
}

export function getDisplayToolKind(name: string): DisplayToolKind {
  switch (name) {
    case 'Shell':
      return 'shell';
    case 'ReadFile':
      return 'read-file';
    case 'WriteFile':
      return 'write-file';
    case 'StrReplaceFile':
      return 'replace-file';
    case 'Glob':
      return 'glob';
    case 'Task':
    case 'Agent':
      return 'task';
    case 'SetTodoList':
      return 'todo';
    default:
      return isTodoToolName(name) ? 'todo' : 'generic';
  }
}

export function isTaskToolName(name: string): boolean {
  return name === 'Task' || name === 'Agent';
}

export function isTodoToolName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[_\s-]+/g, '');
  return normalized === 'settodolist' || normalized === 'todolist' || normalized === 'updatingtodolist' || normalized === 'updatetodolist' || normalized === 'updatetodos';
}

export function getToolCallSummary(name: string, argumentsText?: string | null): string {
  const args = parseToolArguments(argumentsText);

  switch (name) {
    case 'Shell':
      return getSummaryString(args['command']) ?? 'command';
    case 'ReadFile':
    case 'WriteFile':
    case 'StrReplaceFile':
      return pathBasename(getSummaryString(args['path'])) ?? 'file';
    case 'Glob':
      return getSummaryString(args['pattern']) ?? 'pattern';
    case 'Task':
    case 'Agent':
      return getSummaryString(args['description']) ?? 'subagent task';
    case 'SetTodoList':
      return 'Update Todos';
    default:
      if (isTodoToolName(name)) {
        return 'Update Todos';
      }
      return getGenericToolCallSummary(args);
  }
}

export function getGenericToolCallSummary(args: Record<string, unknown>): string {
  for (const key of GENERIC_SUMMARY_KEYS) {
    const value = getSummaryString(args[key]);
    if (value) {
      return value;
    }
  }
  return '';
}

export function getRichToolDisplayBlocks<T extends { type: string }>(blocks?: readonly T[]): T[] {
  return (blocks ?? []).filter((block) => block.type !== 'brief');
}

export function findTodoDisplayBlock<T extends { type: string }>(blocks?: readonly T[]): Extract<T, { type: 'todo' }> | null {
  const block = (blocks ?? []).find((candidate) => candidate.type === 'todo');
  return block ? (block as Extract<T, { type: 'todo' }>) : null;
}

export function normalizeDisplayTodoStatus(status: unknown): DisplayTodoStatus {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase().replace(/[\s-]+/g, '_') : status;
  if (normalized === 'done' || normalized === 'completed' || normalized === 'complete' || normalized === 'finished') {
    return 'done';
  }
  if (normalized === 'in_progress' || normalized === 'active' || normalized === 'running') {
    return 'in_progress';
  }
  return 'pending';
}

export function displayTodoItemTitle(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (!value || typeof value !== 'object') {
    return '';
  }

  const item = value as Record<string, unknown>;
  const title = item['title'] ?? item['content'] ?? item['text'] ?? item['name'] ?? item['task'];
  return typeof title === 'string' ? title.trim() : '';
}

export function normalizeDisplayTodoItems(value: unknown): DisplayTodoItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): DisplayTodoItem[] => {
    const title = displayTodoItemTitle(entry);
    if (!title) {
      return [];
    }

    const status = entry && typeof entry === 'object' ? normalizeDisplayTodoStatus((entry as Record<string, unknown>)['status']) : 'pending';
    return [{ title, status }];
  });
}

export function parseDisplayJsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function extractDisplayJsonFromText(text: string): unknown {
  const parsed = parseDisplayJsonValue(text);
  if (parsed !== null) {
    return parsed;
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    const candidate = parseDisplayJsonValue(arrayMatch[0]);
    if (candidate !== null) {
      return candidate;
    }
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    const candidate = parseDisplayJsonValue(objectMatch[0]);
    if (candidate !== null) {
      return candidate;
    }
  }

  return null;
}

export function parseDisplayTodoListText(text: string): DisplayTodoItem[] {
  const items: DisplayTodoItem[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(?:[-*]\s*)?\[([^\]]+)\]\s*(.+)$/.exec(line);
    if (!match) {
      continue;
    }

    const title = match[2]?.trim();
    if (title) {
      items.push({ title, status: normalizeDisplayTodoStatus(match[1]) });
    }
  }
  return items;
}

export function extractDisplayTodoItems(value: unknown): DisplayTodoItem[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === 'string') {
    const textItems = parseDisplayTodoListText(value);
    if (textItems.length > 0) {
      return textItems;
    }
    return extractDisplayTodoItems(extractDisplayJsonFromText(value));
  }
  if (Array.isArray(value)) {
    return normalizeDisplayTodoItems(value);
  }
  if (typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  for (const key of TODO_KEYS) {
    const items = extractDisplayTodoItems(record[key]);
    if (items.length > 0) {
      return items;
    }
  }

  const singleTitle = displayTodoItemTitle(record);
  if (singleTitle) {
    return [{ title: singleTitle, status: normalizeDisplayTodoStatus(record['status']) }];
  }

  return [];
}

export function getTodoItemsForToolCall(part: ToolCallLike | DisplayToolCallPart): DisplayTodoItem[] {
  const todoBlock = findTodoDisplayBlock(part.displayBlocks);
  const blockItems = normalizeDisplayTodoItems(todoBlock && typeof todoBlock === 'object' ? (todoBlock as { items?: unknown }).items : undefined);
  if (blockItems.length > 0) {
    return blockItems;
  }

  const outputItems = extractDisplayTodoItems(part.resultText);
  if (outputItems.length > 0) {
    return outputItems;
  }

  return extractDisplayTodoItems(parseToolArguments(part.argumentsText));
}

function getSummaryString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function pathBasename(path: string | null): string | null {
  if (!path) {
    return null;
  }
  return path.split('/').pop() ?? path;
}
