import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { ContextMessage } from '../../../src/agent/context';
import { TodoListReminderInjector } from '../../../src/agent/injection/todo-list';
import type { TodoItem } from '../../../src/tools/builtin/state/todo-list';

interface TodoAgentStub {
  readonly history: ContextMessage[];
  readonly todos: readonly TodoItem[];
  readonly todoListActive: boolean;
}

function todoAgent(stub: TodoAgentStub): Agent {
  return {
    type: 'main',
    context: {
      get history() {
        return stub.history;
      },
      appendSystemReminder: (content: string, origin: ContextMessage['origin']) => {
        stub.history.push({
          role: 'user',
          content: [{ type: 'text', text: `<system-reminder>\n${content}\n</system-reminder>` }],
          toolCalls: [],
          origin,
        });
      },
    },
    tools: {
      data: () => [
        {
          name: 'TodoList',
          description: 'Todo list',
          active: stub.todoListActive,
          source: 'builtin',
        },
      ],
      storeData: () => ({ todo: stub.todos }),
    },
  } as unknown as Agent;
}

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

function lastReminderText(history: readonly ContextMessage[]): string {
  const message = history.findLast((entry) => entry.origin?.kind === 'injection');
  return message?.content.map((part) => (part.type === 'text' ? part.text : '')).join('') ?? '';
}

describe('TodoListReminderInjector', () => {
  it('skips reminder injection when TodoList is not active', async () => {
    const history = Array.from({ length: 10 }, () => assistantMessage());
    const agent = todoAgent({
      history,
      todos: [{ title: 'Investigate todo reminder', status: 'in_progress' }],
      todoListActive: false,
    });
    const injector = new TodoListReminderInjector(agent);

    await injector.inject();

    expect(history).toHaveLength(10);
  });

  it('injects a reminder after enough assistant turns since the last TodoList write', async () => {
    const todos: TodoItem[] = [
      { title: 'Read current TodoList implementation', status: 'in_progress' },
      { title: 'Add reminder injector tests', status: 'pending' },
    ];
    const history = [todoListWrite(todos), ...Array.from({ length: 10 }, () => assistantMessage())];
    const agent = todoAgent({ history, todos, todoListActive: true });
    const injector = new TodoListReminderInjector(agent);

    await injector.inject();

    const text = lastReminderText(history);
    expect(text).toContain('The TodoList tool has not been updated recently');
    expect(text).toContain('NEVER mention this reminder to the user');
    expect(text).toContain('Current todo list:');
    expect(text).toContain('1. [in_progress] Read current TodoList implementation');
    expect(text).toContain('2. [pending] Add reminder injector tests');
  });

  it('does not inject before the assistant-turn threshold', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const history = [todoListWrite(todos), ...Array.from({ length: 9 }, () => assistantMessage())];
    const agent = todoAgent({ history, todos, todoListActive: true });
    const injector = new TodoListReminderInjector(agent);

    await injector.inject();

    expect(history).toHaveLength(10);
  });

  it('does not inject another reminder before the reminder spacing threshold', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const history = [
      todoListWrite(todos),
      ...Array.from({ length: 10 }, () => assistantMessage()),
      priorTodoReminder(),
      ...Array.from({ length: 9 }, () => assistantMessage()),
    ];
    const agent = todoAgent({ history, todos, todoListActive: true });
    const injector = new TodoListReminderInjector(agent);

    await injector.inject();

    expect(history).toHaveLength(21);
  });

  it('does not treat TodoList query mode as a write', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const history = [
      todoListWrite(todos),
      ...Array.from({ length: 5 }, () => assistantMessage()),
      todoListQuery(),
      ...Array.from({ length: 4 }, () => assistantMessage()),
    ];
    const agent = todoAgent({ history, todos, todoListActive: true });
    const injector = new TodoListReminderInjector(agent);

    await injector.inject();

    expect(lastReminderText(history)).toContain('The TodoList tool has not been updated recently');
  });
});
