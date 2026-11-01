import { describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { type TodoItem } from '#/features/todo/todoItem';
import { todoListStaleReminder, todoListWriteStatsBefore } from '#/features/todo/todoListReminder';

function assistantMessage(): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'working' }],
    toolCalls: [],
  };
}

function assistantSteps(count: number): ContextMessage[] {
  return Array.from({ length: count }, () => assistantMessage());
}

function todoListWrite(todos: readonly TodoItem[], id = 'call_todo_write'): ContextMessage {
  return {
    role: 'assistant',
    content: [],
    toolCalls: [
      {
        type: 'function',
        id,
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
    origin: { kind: 'injection', variant: 'todo_list_reminder' },
  };
}

describe('todoListStaleReminder', () => {
  it('skips reminder injection when TodoList is not active', async () => {
    const history = assistantSteps(10);
    const result = todoListStaleReminder({
      history,
      todos: [{ title: 'Investigate todo reminder', status: 'in_progress' }],
      active: false,
    });

    expect(result).toBeUndefined();
  });

  it('injects a reminder after enough assistant steps since the last TodoList write', async () => {
    const todos: TodoItem[] = [
      { title: 'Read current TodoList implementation', status: 'in_progress' },
      { title: 'Add reminder injector tests', status: 'pending' },
    ];
    const history = [todoListWrite(todos), ...assistantSteps(10)];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result?.stepsSinceLastWrite).toBe(10);
    expect(result?.text).toContain('If the list still matches your progress, no update is needed');
    expect(result?.text).toContain('1. [in_progress] Read current TodoList implementation');
    expect(result?.text).toContain('2. [pending] Add reminder injector tests');
  });

  it('does not inject before the assistant-step threshold', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const history = [todoListWrite(todos), ...assistantSteps(9)];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toBeUndefined();
  });

  it('does not inject another reminder before the reminder spacing threshold', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const history = [
      todoListWrite(todos),
      ...assistantSteps(10),
      priorTodoReminder(),
      ...assistantSteps(9),
    ];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toBeUndefined();
  });

  it('injects again once the reminder spacing threshold has passed', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const history = [
      todoListWrite(todos),
      ...assistantSteps(10),
      priorTodoReminder(),
      ...assistantSteps(10),
    ];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result?.stepsSinceLastWrite).toBe(20);
  });

  it('does not treat TodoList query mode as a write', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const history = [
      todoListWrite(todos),
      ...assistantSteps(8),
      todoListQuery(),
      ...assistantSteps(1),
    ];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toBeDefined();
  });

  it('stays silent once every item is done', async () => {
    const todos: TodoItem[] = [
      { title: 'Read code', status: 'done' },
      { title: 'Write tests', status: 'done' },
    ];
    const history = [todoListWrite(todos), ...assistantSteps(12)];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toBeUndefined();
  });

  it('stays silent while the list is empty', async () => {
    const result = todoListStaleReminder({ history: assistantSteps(12), todos: [], active: true });

    expect(result).toBeUndefined();
  });
});

describe('todoListWriteStatsBefore', () => {
  const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];

  it('counts the steps since the previous write and notices a reminder in between', () => {
    const history = [
      todoListWrite(todos, 'call_first'),
      ...assistantSteps(2),
      priorTodoReminder(),
      ...assistantSteps(1),
      todoListWrite(todos, 'call_second'),
    ];

    expect(todoListWriteStatsBefore(history, 'call_second')).toEqual({
      stepsSinceLastWrite: 3,
      remindedSinceLastWrite: true,
    });
  });

  it('ignores a reminder that came before the previous write', () => {
    const history = [
      priorTodoReminder(),
      todoListWrite(todos, 'call_first'),
      ...assistantSteps(1),
      todoListWrite(todos, 'call_second'),
    ];

    expect(todoListWriteStatsBefore(history, 'call_second')).toEqual({
      stepsSinceLastWrite: 1,
      remindedSinceLastWrite: false,
    });
  });

  it('omits the step count when no earlier write is in context', () => {
    const history = [...assistantSteps(2), todoListWrite(todos, 'call_first')];

    expect(todoListWriteStatsBefore(history, 'call_first')).toEqual({
      remindedSinceLastWrite: false,
    });
  });
});
