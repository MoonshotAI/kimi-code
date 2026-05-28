import { describe, it, expect } from 'vitest';

import {
  TodoPanelComponent,
  selectVisibleTodos,
  type TodoItem,
} from '#/tui/components/chrome/todo-panel';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('TodoPanelComponent', () => {
  it('returns no lines when empty (so the layout slot collapses)', () => {
    const panel = new TodoPanelComponent(darkColors);
    expect(panel.render(80)).toEqual([]);
    expect(panel.isEmpty()).toBe(true);
  });

  it('renders a Todo header + one row per entry', () => {
    const panel = new TodoPanelComponent(darkColors);
    panel.setTodos([
      { title: 'Investigate parser', status: 'done' },
      { title: 'Add tests', status: 'in_progress' },
      { title: 'Open PR', status: 'pending' },
    ]);
    const lines = panel.render(80).map(strip);
    const joined = lines.join('\n');
    expect(joined).toMatch(/Todo/);
    expect(joined).toMatch(/✓ Investigate parser/);
    expect(joined).toMatch(/● Add tests/);
    expect(joined).toMatch(/○ Open PR/);
  });

  it('setTodos replaces the list (not appends)', () => {
    const panel = new TodoPanelComponent(darkColors);
    panel.setTodos([{ title: 'old', status: 'pending' }]);
    panel.setTodos([{ title: 'new', status: 'in_progress' }]);
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/● new/);
    expect(out).not.toMatch(/old/);
  });

  it('clear() wipes the list and reverts to empty', () => {
    const panel = new TodoPanelComponent(darkColors);
    panel.setTodos([{ title: 'x', status: 'pending' }]);
    panel.clear();
    expect(panel.isEmpty()).toBe(true);
    expect(panel.render(80)).toEqual([]);
  });

  it('defensive copy: external mutation does not leak into the panel', () => {
    const panel = new TodoPanelComponent(darkColors);
    const source: TodoItem[] = [{ title: 'foo', status: 'pending' }];
    panel.setTodos(source);
    source[0] = { title: 'hacked', status: 'done' };
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/○ foo/);
    expect(out).not.toMatch(/hacked/);
  });

  it('renders all todos and no overflow footer when count <= 5', () => {
    const panel = new TodoPanelComponent(darkColors);
    panel.setTodos([
      { title: 'a', status: 'done' },
      { title: 'b', status: 'in_progress' },
      { title: 'c', status: 'pending' },
      { title: 'd', status: 'pending' },
      { title: 'e', status: 'pending' },
    ]);
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/a/);
    expect(out).toMatch(/e/);
    expect(out).not.toMatch(/\+\d+ more/);
  });

  it('appends "+N more" footer when count > 5', () => {
    const panel = new TodoPanelComponent(darkColors);
    panel.setTodos([
      { title: 't0', status: 'done' },
      { title: 't1', status: 'in_progress' },
      { title: 't2', status: 'pending' },
      { title: 't3', status: 'pending' },
      { title: 't4', status: 'pending' },
      { title: 't5', status: 'pending' },
      { title: 't6', status: 'pending' },
    ]);
    const out = strip(panel.render(80).join('\n'));
    expect(out).toMatch(/\+2 more/);
  });
});

describe('selectVisibleTodos', () => {
  const T = (title: string, status: TodoItem['status']): TodoItem => ({ title, status });

  it('returns all items unchanged when count <= 5', () => {
    const todos: TodoItem[] = [
      T('a', 'done'),
      T('b', 'in_progress'),
      T('c', 'pending'),
    ];
    const { rows, hidden } = selectVisibleTodos(todos);
    expect(rows).toEqual(todos);
    expect(hidden).toBe(0);
  });

  it('with 1 in_progress: shows 1 done before + in_progress + 3 pending after', () => {
    const todos: TodoItem[] = [
      T('d1', 'done'),
      T('d2', 'done'),
      T('d3', 'done'),
      T('ip', 'in_progress'),
      T('p1', 'pending'),
      T('p2', 'pending'),
      T('p3', 'pending'),
      T('p4', 'pending'),
      T('p5', 'pending'),
    ];
    const { rows, hidden } = selectVisibleTodos(todos);
    expect(rows.map((r) => r.title)).toEqual(['d3', 'ip', 'p1', 'p2', 'p3']);
    expect(hidden).toBe(4);
  });

  it('with 1 in_progress and no done before: fills with pending after', () => {
    const todos: TodoItem[] = [
      T('ip', 'in_progress'),
      T('p1', 'pending'),
      T('p2', 'pending'),
      T('p3', 'pending'),
      T('p4', 'pending'),
      T('p5', 'pending'),
      T('p6', 'pending'),
    ];
    const { rows, hidden } = selectVisibleTodos(todos);
    expect(rows.map((r) => r.title)).toEqual(['ip', 'p1', 'p2', 'p3', 'p4']);
    expect(hidden).toBe(2);
  });

  it('with 1 in_progress and few pending after: expands done before', () => {
    const todos: TodoItem[] = [
      T('d1', 'done'),
      T('d2', 'done'),
      T('d3', 'done'),
      T('d4', 'done'),
      T('d5', 'done'),
      T('ip', 'in_progress'),
      T('p1', 'pending'),
    ];
    const { rows, hidden } = selectVisibleTodos(todos);
    expect(rows.map((r) => r.title)).toEqual(['d3', 'd4', 'd5', 'ip', 'p1']);
    expect(hidden).toBe(2);
  });

  it('all pending: shows first 5', () => {
    const todos: TodoItem[] = Array.from({ length: 8 }, (_, i) => T(`p${i}`, 'pending'));
    const { rows, hidden } = selectVisibleTodos(todos);
    expect(rows.map((r) => r.title)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    expect(hidden).toBe(3);
  });

  it('all done: shows last 5', () => {
    const todos: TodoItem[] = Array.from({ length: 8 }, (_, i) => T(`d${i}`, 'done'));
    const { rows, hidden } = selectVisibleTodos(todos);
    expect(rows.map((r) => r.title)).toEqual(['d3', 'd4', 'd5', 'd6', 'd7']);
    expect(hidden).toBe(3);
  });

  it('mixed done+pending without in_progress: 1 done + 4 pending', () => {
    const todos: TodoItem[] = [
      T('d1', 'done'),
      T('d2', 'done'),
      T('d3', 'done'),
      T('p1', 'pending'),
      T('p2', 'pending'),
      T('p3', 'pending'),
      T('p4', 'pending'),
      T('p5', 'pending'),
    ];
    const { rows, hidden } = selectVisibleTodos(todos);
    expect(rows.map((r) => r.title)).toEqual(['d3', 'p1', 'p2', 'p3', 'p4']);
    expect(hidden).toBe(3);
  });

  it('multiple in_progress: all included up to MAX cap', () => {
    const todos: TodoItem[] = [
      T('ip1', 'in_progress'),
      T('ip2', 'in_progress'),
      T('ip3', 'in_progress'),
      T('p1', 'pending'),
      T('p2', 'pending'),
      T('p3', 'pending'),
      T('p4', 'pending'),
    ];
    const { rows, hidden } = selectVisibleTodos(todos);
    expect(rows.map((r) => r.title)).toEqual(['ip1', 'ip2', 'ip3', 'p1', 'p2']);
    expect(hidden).toBe(2);
  });

  it('no in_progress, interleaved done/pending order: still picks MAX items', () => {
    const todos: TodoItem[] = [
      T('p0', 'pending'),
      T('d0', 'done'),
      T('p1', 'pending'),
      T('d1', 'done'),
      T('p2', 'pending'),
      T('d2', 'done'),
      T('p3', 'pending'),
    ];
    const { rows, hidden } = selectVisibleTodos(todos);
    expect(rows.length).toBe(5);
    expect(hidden).toBe(2);
    expect(rows.filter((r) => r.status === 'pending').length).toBe(4);
    expect(rows.filter((r) => r.status === 'done').length).toBe(1);
  });

  it('done appearing after in_progress is still treated as recent context', () => {
    const todos: TodoItem[] = [
      T('ip', 'in_progress'),
      T('p1', 'pending'),
      T('d1', 'done'),
      T('p2', 'pending'),
      T('p3', 'pending'),
      T('p4', 'pending'),
      T('p5', 'pending'),
    ];
    const { rows, hidden } = selectVisibleTodos(todos);
    expect(rows.length).toBe(5);
    expect(hidden).toBe(2);
    expect(rows.some((r) => r.status === 'in_progress')).toBe(true);
    expect(rows.some((r) => r.status === 'done')).toBe(true);
  });

  it('more than 5 in_progress: caps at 5 keeping the earliest', () => {
    const todos: TodoItem[] = Array.from({ length: 7 }, (_, i) =>
      T(`ip${i}`, 'in_progress'),
    );
    const { rows, hidden } = selectVisibleTodos(todos);
    expect(rows.map((r) => r.title)).toEqual(['ip0', 'ip1', 'ip2', 'ip3', 'ip4']);
    expect(hidden).toBe(2);
  });
});
