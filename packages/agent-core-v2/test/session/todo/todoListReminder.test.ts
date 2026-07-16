import { describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { type TodoItem } from '#/session/todo/todoItem';
import { todoListStaleReminder } from '#/session/todo/todoListReminder';

function assistantMessage(): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'working' }],
    toolCalls: [],
  };
}

function todoListWrite(todos: readonly TodoItem[]): ContextMessage {
  return {
    role: 'assistant',
    content: [],
    toolCalls: [
      {
        type: 'function',
        id: 'call_todo_write',
        name: 'TodoList',
        arguments: JSON.stringify({ todos }),
      },
    ],
  };
}

function todoListQuery(): ContextMessage {
  return {
    role: 'assistant',
    content: [],
    toolCalls: [
      {
        type: 'function',
        id: 'call_todo_query',
        name: 'TodoList',
        arguments: JSON.stringify({}),
      },
    ],
  };
}

function priorTodoReminder(): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder>\nPrior todo reminder\n</system-reminder>' }],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'todo_list_reminder' },
  };
}

describe('todoListStaleReminder', () => {
  it('skips reminder injection when TodoList is not active', async () => {
    const history = Array.from({ length: 10 }, () => assistantMessage());
    const result = todoListStaleReminder({
      history,
      todos: [{ id: 'T1', parentId: null, title: 'Investigate todo reminder', status: 'in_progress', createdAt: Date.now(), updatedAt: Date.now() }],
      active: false,
    });

    expect(result).toBeUndefined();
  });

  it('injects a reminder after enough assistant turns since the last TodoList write', async () => {
    const todos: TodoItem[] = [
      { id: 'T1', parentId: null, title: 'Read current TodoList implementation', status: 'in_progress', createdAt: Date.now(), updatedAt: Date.now() },
      { id: 'T2', parentId: null, title: 'Add reminder injector tests', status: 'open', createdAt: Date.now(), updatedAt: Date.now() },
    ];
    const history = [todoListWrite(todos), ...Array.from({ length: 10 }, () => assistantMessage())];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toContain('The TodoList tool has not been updated recently');
    expect(result).toContain('NEVER mention this reminder to the user');
    expect(result).toContain('Current todo list:');
    expect(result).toContain('T1. [in_progress] Read current TodoList implementation');
    expect(result).toContain('T2. [open] Add reminder injector tests');
  });

  it('does not inject before the assistant-turn threshold', async () => {
    const todos: TodoItem[] = [{ id: 'T1', parentId: null, title: 'Read code', status: 'in_progress', createdAt: Date.now(), updatedAt: Date.now() }];
    const history = [todoListWrite(todos), ...Array.from({ length: 9 }, () => assistantMessage())];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toBeUndefined();
  });

  it('does not inject another reminder before the reminder spacing threshold', async () => {
    const todos: TodoItem[] = [{ id: 'T1', parentId: null, title: 'Read code', status: 'in_progress', createdAt: Date.now(), updatedAt: Date.now() }];
    const history = [
      todoListWrite(todos),
      ...Array.from({ length: 10 }, () => assistantMessage()),
      priorTodoReminder(),
      ...Array.from({ length: 9 }, () => assistantMessage()),
    ];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toBeUndefined();
  });

  it('does not treat TodoList query mode as a write', async () => {
    const todos: TodoItem[] = [{ id: 'T1', parentId: null, title: 'Read code', status: 'in_progress', createdAt: Date.now(), updatedAt: Date.now() }];
    const history = [
      todoListWrite(todos),
      ...Array.from({ length: 5 }, () => assistantMessage()),
      todoListQuery(),
      ...Array.from({ length: 4 }, () => assistantMessage()),
    ];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toContain('The TodoList tool has not been updated recently');
  });
});
