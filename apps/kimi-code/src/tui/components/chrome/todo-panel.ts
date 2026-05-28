/**
 * TodoPanel — live-updating TODO list shown before the input area.
 *
 * Mounted as a dedicated `Container` slot between the activity pane
 * (spinners / thinking stream) and the queue / editor block. The host
 * calls {@link setTodos} whenever the LLM invokes the `TodoList`
 * tool; state survives across turns so the list stays visible until
 * explicitly cleared (`todos: []`), a new session starts, or `/clear`
 * is issued.
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { ColorPalette } from '#/tui/theme/colors';

export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  readonly title: string;
  readonly status: TodoStatus;
}

const MAX_VISIBLE = 5;

export interface VisibleTodos {
  readonly rows: readonly TodoItem[];
  readonly hidden: number;
}

/**
 * Pick which todos to render when the list exceeds {@link MAX_VISIBLE}.
 *
 * Strategy: prioritise the user's current focus.
 * 1. Include every `in_progress` item (capped at MAX_VISIBLE).
 * 2. Anchor on the in_progress range and fill remaining slots with
 *    "what's next" (pending after the anchor), reserving one slot for
 *    "what just finished" (done before the anchor) when both sides
 *    have candidates.
 * 3. With no in_progress, anchor between the last done and the first
 *    pending; otherwise fall back to last-5 (all done) or first-5
 *    (all pending).
 *
 * Items are returned in their original order.
 */
export function selectVisibleTodos(todos: readonly TodoItem[]): VisibleTodos {
  if (todos.length <= MAX_VISIBLE) {
    return { rows: [...todos], hidden: 0 };
  }

  const ipIndices: number[] = [];
  for (const [i, todo] of todos.entries()) {
    if (todo.status === 'in_progress') ipIndices.push(i);
  }

  const picked = new Set<number>();
  for (const i of ipIndices.slice(0, MAX_VISIBLE)) picked.add(i);

  if (picked.size < MAX_VISIBLE) {
    let beforeAnchor: number;
    let afterAnchor: number;

    if (ipIndices.length > 0) {
      beforeAnchor = ipIndices[0] as number;
      afterAnchor = ipIndices.at(-1) as number;
    } else {
      const firstPending = todos.findIndex((t) => t.status === 'pending');
      let lastDone = -1;
      for (let i = todos.length - 1; i >= 0; i--) {
        if (todos[i]?.status === 'done') {
          lastDone = i;
          break;
        }
      }
      if (firstPending < 0) {
        beforeAnchor = todos.length;
        afterAnchor = todos.length;
      } else if (lastDone < 0) {
        beforeAnchor = -1;
        afterAnchor = -1;
      } else {
        beforeAnchor = firstPending;
        afterAnchor = lastDone;
      }
    }

    const before: number[] = [];
    for (let i = beforeAnchor - 1; i >= 0; i--) {
      if (!picked.has(i)) before.push(i);
    }
    const after: number[] = [];
    for (let i = afterAnchor + 1; i < todos.length; i++) {
      if (!picked.has(i)) after.push(i);
    }

    const remaining = MAX_VISIBLE - picked.size;
    let beforeAlloc = 0;
    let afterAlloc = 0;

    if (before.length === 0) {
      afterAlloc = Math.min(remaining, after.length);
    } else if (after.length === 0) {
      beforeAlloc = Math.min(remaining, before.length);
    } else {
      beforeAlloc = 1;
      afterAlloc = Math.min(remaining - 1, after.length);
      if (afterAlloc < remaining - 1) {
        beforeAlloc = Math.min(before.length, remaining - afterAlloc);
      }
    }

    for (let i = 0; i < beforeAlloc; i++) picked.add(before[i] as number);
    for (let i = 0; i < afterAlloc; i++) picked.add(after[i] as number);
  }

  const sortedIdx = [...picked].toSorted((a, b) => a - b);
  return {
    rows: sortedIdx.map((i) => todos[i] as TodoItem),
    hidden: todos.length - sortedIdx.length,
  };
}

export class TodoPanelComponent implements Component {
  private todos: readonly TodoItem[] = [];
  private colors: ColorPalette;

  constructor(colors: ColorPalette) {
    this.colors = colors;
  }

  setTodos(todos: readonly TodoItem[]): void {
    this.todos = todos.map((t) => ({ title: t.title, status: t.status }));
  }

  getTodos(): readonly TodoItem[] {
    return this.todos;
  }

  clear(): void {
    this.todos = [];
  }

  isEmpty(): boolean {
    return this.todos.length === 0;
  }

  setColors(colors: ColorPalette): void {
    this.colors = colors;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.todos.length === 0) return [];
    const c = this.colors;
    const { rows, hidden } = selectVisibleTodos(this.todos);
    const lines: string[] = [
      chalk.hex(c.border)('─'.repeat(width)),
      chalk.hex(c.primary).bold(' Todo'),
    ];
    for (const todo of rows) {
      lines.push(renderRow(todo, c));
    }
    if (hidden > 0) {
      lines.push(chalk.hex(c.textDim)(`  … +${hidden} more`));
    }

    return lines.map((line) => truncateToWidth(line, width));
  }
}

function renderRow(todo: TodoItem, colors: ColorPalette): string {
  const marker = statusMarker(todo.status, colors);
  const titleStyled = styleTitle(todo.title, todo.status, colors);
  return `  ${marker} ${titleStyled}`;
}

function statusMarker(status: TodoStatus, colors: ColorPalette): string {
  switch (status) {
    case 'in_progress':
      return chalk.hex(colors.primary).bold('●');
    case 'done':
      return chalk.hex(colors.success)('✓');
    case 'pending':
      return chalk.hex(colors.textDim)('○');
  }
}

function styleTitle(title: string, status: TodoStatus, colors: ColorPalette): string {
  switch (status) {
    case 'in_progress':
      return chalk.hex(colors.text).bold(title);
    case 'done':
      return chalk.hex(colors.textDim).strikethrough(title);
    case 'pending':
      return chalk.hex(colors.text)(title);
  }
}
