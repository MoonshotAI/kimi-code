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
  // Mid-turn assistant step: a tool call is still in flight, so the turn has
  // not ended.
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'working' }],
    toolCalls: [
      {
        type: 'function',
        id: 'call_bash',
        name: 'Bash',
        arguments: JSON.stringify({ command: 'true' }),
      },
    ],
  };
}

function turnEndedMessage(): ContextMessage {
  // Final assistant step of a completed turn: no tool calls remain.
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'done for now' }],
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

function userPrompt(): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'next task please' }],
    toolCalls: [],
    origin: { kind: 'user' },
  } as ContextMessage;
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

  it('reminds at the next step when a turn ends with unfinished todos and no write', async () => {
    const todos: TodoItem[] = [
      { title: 'Implement feature', status: 'done' },
      { title: 'Mark todo done', status: 'in_progress' },
    ];
    // Only 3 turns since the last write — far below the cadence threshold —
    // and the write happened in a previous turn; the just-finished turn
    // closed without any TodoList write.
    const history = [
      todoListWrite(todos),
      userPrompt(),
      ...Array.from({ length: 3 }, () => assistantMessage()),
      turnEndedMessage(),
    ];
    const agent = todoAgent({ history, todos, todoListActive: true });
    const injector = new TodoListReminderInjector(agent);

    await injector.inject();

    const text = lastReminderText(history);
    expect(text).toContain('The previous turn ended with unfinished todo items');
    expect(text).toContain('Unfinished todo items:');
    expect(text).toContain('1. [in_progress] Mark todo done');
    expect(text).not.toContain('Implement feature');
  });

  it('does not fire the turn-end rule mid-turn (tool calls still in flight)', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const history = [todoListWrite(todos), ...Array.from({ length: 3 }, () => assistantMessage())];
    const agent = todoAgent({ history, todos, todoListActive: true });
    const injector = new TodoListReminderInjector(agent);

    await injector.inject();

    expect(history).toHaveLength(4);
  });

  it('does not fire the turn-end rule when the final step was a TodoList write', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const history = [
      ...Array.from({ length: 3 }, () => assistantMessage()),
      todoListWrite(todos),
    ];
    const agent = todoAgent({ history, todos, todoListActive: true });
    const injector = new TodoListReminderInjector(agent);

    await injector.inject();

    expect(history).toHaveLength(4);
  });

  it('does not fire the turn-end rule when every todo is done', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'done' }];
    const history = [
      todoListWrite(todos),
      ...Array.from({ length: 3 }, () => assistantMessage()),
      turnEndedMessage(),
    ];
    const agent = todoAgent({ history, todos, todoListActive: true });
    const injector = new TodoListReminderInjector(agent);

    await injector.inject();

    expect(history).toHaveLength(5);
  });

  it('does not fire when the just-finished turn already wrote the TodoList', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    // Regression: the agent updated the TodoList mid-turn, got the tool
    // result, then closed the turn with a text-only reply. The write happened
    // inside this same turn, so there is nothing to reconcile.
    const history = [
      userPrompt(),
      ...Array.from({ length: 2 }, () => assistantMessage()),
      todoListWrite(todos),
      assistantMessage(),
      turnEndedMessage(),
      userPrompt(),
    ];
    const agent = todoAgent({ history, todos, todoListActive: true });
    const injector = new TodoListReminderInjector(agent);

    await injector.inject();

    expect(history).toHaveLength(7);
  });

  it('still fires when the last write happened before the just-finished turn', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const history = [
      todoListWrite(todos),
      userPrompt(),
      ...Array.from({ length: 2 }, () => assistantMessage()),
      turnEndedMessage(),
      userPrompt(),
    ];
    const agent = todoAgent({ history, todos, todoListActive: true });
    const injector = new TodoListReminderInjector(agent);

    await injector.inject();

    expect(lastReminderText(history)).toContain('The previous turn ended with unfinished todo items');
  });

  it('spaces out turn-end reminders', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const history = [
      todoListWrite(todos),
      userPrompt(),
      priorTodoReminder(),
      ...Array.from({ length: 1 }, () => assistantMessage()),
      turnEndedMessage(),
      userPrompt(),
    ];
    const agent = todoAgent({ history, todos, todoListActive: true });
    const injector = new TodoListReminderInjector(agent);

    await injector.inject();

    // Only 2 assistant turns since the last reminder — below the spacing.
    expect(history).toHaveLength(6);

    history.push(...Array.from({ length: 2 }, () => assistantMessage()), turnEndedMessage());
    await injector.inject();

    const text = lastReminderText(history);
    expect(text).toContain('The previous turn ended with unfinished todo items');
  });
});
