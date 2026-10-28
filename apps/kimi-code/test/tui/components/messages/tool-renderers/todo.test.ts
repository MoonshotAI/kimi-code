import { describe, expect, it } from 'vitest';

import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import {
  formatHiddenCounts,
  selectVisibleTodos,
  type TodoItem,
} from '#/tui/components/messages/tool-renderers/todo';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const todo = (title: string, status: TodoItem['status']): TodoItem => ({ title, status });

function resultText(todos: readonly TodoItem[]): string {
  return ['Current todo list:', ...todos.map((item) => `  [${item.status}] ${item.title}`)].join('\n');
}

function todoCard(todos: readonly TodoItem[], isError = false): ToolCallComponent {
  return new ToolCallComponent(
    { id: 'call_todo', name: 'TodoList', args: { todos } },
    {
      tool_call_id: 'call_todo',
      output: isError ? 'Invalid todo list' : `Todo list updated.\n${resultText(todos)}\n\nMark the next item in_progress.`,
      is_error: isError,
    },
  );
}

function cardLines(card: ToolCallComponent): string[] {
  return card
    .render(80)
    .map((line) => strip(line).trimEnd())
    .filter((line) => line.length > 0);
}

describe('TodoList card', () => {
  it('shows every item of a short list and has nothing to expand', () => {
    const card = todoCard([todo('Read the code', 'done'), todo('Fix it', 'in_progress'), todo('Test', 'pending')]);
    expect(cardLines(card).slice(1)).toEqual(['  ✓ Read the code', '  ● Fix it', '  ○ Test']);
    expect(card.hasHiddenContent()).toBe(false);
  });

  it('shows two items plus a summary of the rest when collapsed, and every item when expanded', () => {
    const card = todoCard([
      todo('d1', 'done'),
      todo('ip', 'in_progress'),
      todo('p1', 'pending'),
      todo('p2', 'pending'),
      todo('p3', 'pending'),
    ]);
    expect(cardLines(card).slice(1)).toEqual([
      '  ✓ d1',
      '  ● ip',
      '  … +3 more (3 pending) · ctrl+o to expand',
    ]);
    expect(card.hasHiddenContent()).toBe(true);

    card.setExpanded(true);
    expect(cardLines(card).slice(1)).toEqual(['  ✓ d1', '  ● ip', '  ○ p1', '  ○ p2', '  ○ p3']);
  });

  it('shows the list a read-only call reports under a Read headline', () => {
    const todos = [todo('Read the code', 'done'), todo('Fix it', 'in_progress')];
    const card = new ToolCallComponent(
      { id: 'call_read', name: 'TodoList', args: {} },
      { tool_call_id: 'call_read', output: resultText(todos), is_error: false },
    );
    expect(cardLines(card)).toEqual(['● Read TodoList', '  ✓ Read the code', '  ● Fix it']);
    expect(cardLines(todoCard(todos))[0]).toBe('● Used TodoList');
  });

  it('keeps only the headline when a row does not parse, instead of inventing items', () => {
    const output = [
      'Todo list updated.',
      'Current todo list:',
      '  [in_progress] Update docs',
      '[pending] quoted status',
      '',
      '"Update docs" is the last open item.',
    ].join('\n');
    const card = new ToolCallComponent(
      { id: 'call_multi', name: 'TodoList', args: { todos: [] } },
      { tool_call_id: 'call_multi', output, is_error: false },
    );
    expect(cardLines(card)).toEqual(['● Used TodoList']);
  });

  it('keeps only the headline for a cleared list and for a failed call', () => {
    const cleared = new ToolCallComponent(
      { id: 'call_clear', name: 'TodoList', args: { todos: [] } },
      { tool_call_id: 'call_clear', output: 'Todo list cleared.', is_error: false },
    );
    expect(cardLines(cleared)).toEqual(['● Used TodoList']);
    expect(cardLines(todoCard([todo('a', 'pending')], true)).join('\n')).not.toContain('○ a');
  });
});

describe('selectVisibleTodos', () => {
  it('keeps a list of up to three items whole', () => {
    const todos = [todo('a', 'done'), todo('b', 'in_progress'), todo('c', 'pending')];
    expect(selectVisibleTodos(todos)).toEqual({
      rows: todos,
      hidden: 0,
      hiddenCounts: { done: 0, in_progress: 0, pending: 0 },
    });
  });

  it('pairs the in-progress item with the latest done item', () => {
    const todos = [todo('d1', 'done'), todo('d2', 'done'), todo('ip', 'in_progress'), todo('p1', 'pending')];
    const { rows, hidden, hiddenCounts } = selectVisibleTodos(todos);
    expect(rows.map((r) => r.title)).toEqual(['d2', 'ip']);
    expect(hidden).toBe(2);
    expect(hiddenCounts).toEqual({ done: 1, in_progress: 0, pending: 1 });
  });

  it('fills with the earliest pending items when nothing is done', () => {
    const todos = [todo('ip', 'in_progress'), todo('p1', 'pending'), todo('p2', 'pending'), todo('p3', 'pending')];
    expect(selectVisibleTodos(todos).rows.map((r) => r.title)).toEqual(['ip', 'p1']);
  });

  it('shows the latest done and the earliest pending item without an in-progress item', () => {
    const todos = [todo('p0', 'pending'), todo('d0', 'done'), todo('p1', 'pending'), todo('d1', 'done')];
    expect(selectVisibleTodos(todos).rows.map((r) => r.title)).toEqual(['p0', 'd1']);
  });

  it('shows the last two items of an all-done list', () => {
    const todos = Array.from({ length: 5 }, (_, i) => todo(`d${String(i)}`, 'done'));
    expect(selectVisibleTodos(todos).rows.map((r) => r.title)).toEqual(['d3', 'd4']);
  });

  it('caps in-progress items at two, keeping the earliest', () => {
    const todos = Array.from({ length: 5 }, (_, i) => todo(`ip${String(i)}`, 'in_progress'));
    const { rows, hiddenCounts } = selectVisibleTodos(todos);
    expect(rows.map((r) => r.title)).toEqual(['ip0', 'ip1']);
    expect(hiddenCounts).toEqual({ done: 0, in_progress: 3, pending: 0 });
  });
});

describe('formatHiddenCounts', () => {
  it('formats all three statuses in done / in progress / pending order', () => {
    expect(formatHiddenCounts({ done: 2, in_progress: 1, pending: 3 })).toBe(
      '2 done · 1 in progress · 3 pending',
    );
  });

  it('omits zero-count statuses', () => {
    expect(formatHiddenCounts({ done: 5, in_progress: 0, pending: 0 })).toBe('5 done');
    expect(formatHiddenCounts({ done: 0, in_progress: 0, pending: 0 })).toBe('');
  });
});
