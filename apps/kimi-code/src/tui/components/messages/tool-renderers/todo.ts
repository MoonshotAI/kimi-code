import { renderComponentLines, truncateToWidth, visibleWidth, type Component } from '@moonshot-ai/pi-tui';

import { OUTCOME_ROW_INDENT, TRUNCATION_ELLIPSIS } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';

import type { TranscriptRowParts } from '../transcript-row-layout';
import { splitToolTranscriptRow, toolTranscriptGutterWidths } from './transcript-row';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

const COLLAPSED_ROWS = 2;

export interface VisibleTodos {
  readonly rows: readonly TodoItem[];
  readonly hidden: number;
  readonly hiddenCounts: Record<TodoStatus, number>;
}

const LIST_HEADER = 'Current todo list:';
const RESULT_ROW = /^ {2}\[(pending|in_progress|done)\] (.+)$/;

export function todoListFromResult(output: string): TodoItem[] {
  const lines = output.split('\n');
  const start = lines.indexOf(LIST_HEADER);
  if (start === -1) return [];
  const end = lines.indexOf('', start + 1);
  const todos: TodoItem[] = [];
  for (const line of lines.slice(start + 1, end === -1 ? undefined : end)) {
    const match = RESULT_ROW.exec(line);
    if (match === null) return [];
    todos.push({ status: match[1] as TodoStatus, title: match[2]! });
  }
  return todos;
}

export function isTodoListRead(args: Record<string, unknown>): boolean {
  return args['todos'] === undefined;
}

export function todoCardHidesItems(todos: readonly TodoItem[]): boolean {
  return todos.length > COLLAPSED_ROWS + 1;
}

export function selectVisibleTodos(todos: readonly TodoItem[]): VisibleTodos {
  if (!todoCardHidesItems(todos)) {
    return {
      rows: [...todos],
      hidden: 0,
      hiddenCounts: { done: 0, in_progress: 0, pending: 0 },
    };
  }

  const inProgress: number[] = [];
  const pending: number[] = [];
  const done: number[] = [];
  for (const [i, todo] of todos.entries()) {
    if (todo.status === 'in_progress') inProgress.push(i);
    else if (todo.status === 'pending') pending.push(i);
    else done.push(i);
  }

  const picked = new Set<number>();
  for (const i of inProgress.slice(0, COLLAPSED_ROWS)) picked.add(i);

  if (picked.size < COLLAPSED_ROWS) {
    const doneCandidates = done.toReversed();
    const remaining = COLLAPSED_ROWS - picked.size;
    let doneCount: number;
    let pendingCount: number;
    if (doneCandidates.length === 0) {
      doneCount = 0;
      pendingCount = Math.min(remaining, pending.length);
    } else if (pending.length === 0) {
      pendingCount = 0;
      doneCount = Math.min(remaining, doneCandidates.length);
    } else {
      doneCount = 1;
      pendingCount = Math.min(remaining - 1, pending.length);
      if (pendingCount < remaining - 1) {
        doneCount = Math.min(doneCandidates.length, remaining - pendingCount);
      }
    }

    for (let i = 0; i < doneCount; i++) picked.add(doneCandidates[i] as number);
    for (let i = 0; i < pendingCount; i++) picked.add(pending[i] as number);
  }

  const hiddenCounts: Record<TodoStatus, number> = { done: 0, in_progress: 0, pending: 0 };
  for (const [i, todo] of todos.entries()) {
    if (!picked.has(i)) hiddenCounts[todo.status] += 1;
  }

  return {
    rows: [...picked].toSorted((a, b) => a - b).map((i) => todos[i] as TodoItem),
    hidden: todos.length - picked.size,
    hiddenCounts,
  };
}

const STATUS_LABELS: readonly { status: TodoStatus; label: string }[] = [
  { status: 'done', label: 'done' },
  { status: 'in_progress', label: 'in progress' },
  { status: 'pending', label: 'pending' },
];

export function formatHiddenCounts(counts: Record<TodoStatus, number>): string {
  return STATUS_LABELS.filter(({ status }) => counts[status] > 0)
    .map(({ status, label }) => `${String(counts[status])} ${label}`)
    .join(' · ');
}

export class TodoCardBody implements Component {
  constructor(
    private readonly todos: readonly TodoItem[],
    private readonly expanded: boolean,
  ) {}

  invalidate(): void {}

  selectionExclusions(width: number) {
    return [{ start: 0, end: Math.min(visibleWidth(OUTCOME_ROW_INDENT), Math.max(0, width)) }];
  }

  renderTranscriptRow(width: number): TranscriptRowParts {
    const lines = renderComponentLines(this, width);
    return splitToolTranscriptRow(this, lines, width, toolTranscriptGutterWidths(lines));
  }

  render(width: number): string[] {
    const lines: string[] = [];
    if (this.expanded) {
      for (const todo of this.todos) lines.push(renderRow(todo));
    } else {
      const { rows, hidden, hiddenCounts } = selectVisibleTodos(this.todos);
      for (const todo of rows) lines.push(renderRow(todo));
      if (hidden > 0) {
        const distribution = formatHiddenCounts(hiddenCounts);
        const suffix = distribution.length > 0 ? ` (${distribution})` : '';
        lines.push(
          currentTheme.dim(
            `${OUTCOME_ROW_INDENT}${TRUNCATION_ELLIPSIS} +${String(hidden)} more${suffix} · ctrl+o to expand`,
          ),
        );
      }
    }
    return lines.map((line) => truncateToWidth(line, width, TRUNCATION_ELLIPSIS));
  }
}

function renderRow(todo: TodoItem): string {
  return `${OUTCOME_ROW_INDENT}${statusMarker(todo.status)} ${styleTitle(todo)}`;
}

function statusMarker(status: TodoStatus): string {
  switch (status) {
    case 'in_progress':
      return currentTheme.boldFg('primary', '●');
    case 'done':
      return currentTheme.fg('success', '✓');
    case 'pending':
      return currentTheme.fg('textDim', '○');
  }
}

function styleTitle(todo: TodoItem): string {
  switch (todo.status) {
    case 'in_progress':
      return currentTheme.boldFg('text', todo.title);
    case 'done':
      return currentTheme.strikethrough(currentTheme.fg('textDim', todo.title));
    case 'pending':
      return currentTheme.fg('text', todo.title);
  }
}
