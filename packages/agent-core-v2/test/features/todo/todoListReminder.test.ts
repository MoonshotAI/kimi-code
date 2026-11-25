import { call, say, type ModelRequest } from '@moonshot-ai/testkit/model';
import { describe, expect, it, test as base } from 'vitest';

import {
  createCompactionSummaryMessage,
  isCompactionSummaryMessage,
} from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { type TodoItem } from '#/features/todo/todoItem';
import {
  TODO_LIST_GUIDANCE,
  TODO_LIST_GUIDANCE_REMINDER_VARIANT,
  todoListGuidanceReminder,
  todoListStaleReminder,
  todoListWriteStatsBefore,
} from '#/features/todo/todoListReminder';
import {
  testkitAgentFixtures,
  type TestAgentContext,
  type TestkitAgentFixtures,
} from '../../harness';

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

describe('todoListGuidanceReminder', () => {
  const guidanceMessage: ContextMessage = {
    role: 'user',
    content: [{ type: 'text', text: TODO_LIST_GUIDANCE }],
    origin: { kind: 'injection', variant: TODO_LIST_GUIDANCE_REMINDER_VARIANT },
  };

  it('skips when TodoList is inactive or outside a new turn', () => {
    expect(todoListGuidanceReminder({
      active: false,
      isNewTurn: true,
      injectedPositions: [],
      lastInjectedAt: null,
      history: [],
    })).toBeUndefined();
    expect(todoListGuidanceReminder({
      active: true,
      isNewTurn: false,
      injectedPositions: [],
      lastInjectedAt: null,
      history: [],
    })).toBeUndefined();
  });

  it('injects on a new turn when guidance is missing and skips while it remains after any compaction', () => {
    expect(todoListGuidanceReminder({
      active: true,
      isNewTurn: true,
      injectedPositions: [],
      lastInjectedAt: null,
      history: [],
    })).toBe(TODO_LIST_GUIDANCE);

    const history = [createCompactionSummaryMessage('summary'), guidanceMessage, assistantMessage()];
    expect(todoListGuidanceReminder({
      active: true,
      isNewTurn: true,
      injectedPositions: [1],
      lastInjectedAt: 1,
      history,
    })).toBeUndefined();
  });

  it('re-injects when compaction removes the guidance or appends a newer summary after it', () => {
    expect(todoListGuidanceReminder({
      active: true,
      isNewTurn: true,
      injectedPositions: [],
      lastInjectedAt: null,
      history: [createCompactionSummaryMessage('summary')],
    })).toBe(TODO_LIST_GUIDANCE);

    const preserved = [guidanceMessage, createCompactionSummaryMessage('newer summary')];
    expect(todoListGuidanceReminder({
      active: true,
      isNewTurn: true,
      injectedPositions: [0],
      lastInjectedAt: 0,
      history: preserved,
    })).toBe(TODO_LIST_GUIDANCE);
  });
});

describe('TodoList guidance reminder', () => {
  const guidanceTest = base.extend<TestkitAgentFixtures>(testkitAgentFixtures());

  async function runPrompt(ctx: TestAgentContext, text: string): Promise<void> {
    await ctx.rpc.prompt({ input: [{ type: 'text', text }] });
    await ctx.untilTurnEnd();
  }

  function guidanceCount(request: ModelRequest | undefined): number {
    if (request === undefined) return 0;
    return request.view.messages.filter((message) => message.text.includes(TODO_LIST_GUIDANCE)).length;
  }

  function guidanceReminders(ctx: TestAgentContext): readonly ContextMessage[] {
    return ctx.get(IAgentLoopService).history().filter((message) =>
      message.origin?.kind === 'injection' &&
      message.origin.variant === TODO_LIST_GUIDANCE_REMINDER_VARIANT
    );
  }

  guidanceTest('injects the guidance into the first request without repeating it in the next turn', async ({ agent: ctx, model }) => {
    model.script(say('answer to first'), say('answer to second'));
    await ctx.restorePersisted();
    await runPrompt(ctx, 'first');
    await runPrompt(ctx, 'second');

    const requests = model.requests('main');
    expect(requests).toHaveLength(2);
    expect(guidanceCount(requests[0])).toBe(1);
    expect(guidanceCount(requests[1])).toBe(1);
    expect(JSON.stringify(requests[0]?.view.messages)).toContain('<system-reminder>');
    expect(guidanceReminders(ctx)).toHaveLength(1);
    expect(guidanceReminders(ctx)[0]?.role).toBe('user');
  });

  guidanceTest('does not inject the guidance when TodoList is inactive', async ({ agent: ctx, model }) => {
    model.script(say('answer to first'));
    await ctx.restorePersisted();
    ctx.get(IAgentLoopService).update({ activeToolNames: ['Read'] });

    await runPrompt(ctx, 'first');

    expect(guidanceCount(model.requests('main')[0])).toBe(0);
    expect(guidanceReminders(ctx)).toHaveLength(0);
  });

  guidanceTest('re-injects the guidance on the next turn after compaction removes it', async ({ agent: ctx, model }) => {
    model.script(say('answer to first'), say('answer to second'));
    model.lane('compaction').script(say('Compacted summary.'));
    await ctx.restorePersisted();
    await runPrompt(ctx, 'first');

    const compacted = ctx.once('full_compaction.complete');
    await ctx.rpc.beginCompaction({});
    await compacted;
    expect(guidanceReminders(ctx)).toHaveLength(0);

    await runPrompt(ctx, 'second');

    const requests = model.requests('main');
    expect(requests).toHaveLength(2);
    expect(guidanceCount(requests[0])).toBe(1);
    expect(guidanceCount(requests[1])).toBe(1);
    expect(guidanceReminders(ctx)).toHaveLength(1);
    const history = ctx.get(IAgentLoopService).history();
    const summaryIndex = history.findIndex(isCompactionSummaryMessage);
    const guidanceIndex = history.findIndex((message) =>
      message.origin?.kind === 'injection' &&
      message.origin.variant === TODO_LIST_GUIDANCE_REMINDER_VARIANT
    );
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(guidanceIndex).toBeGreaterThan(summaryIndex);
  });

  guidanceTest('re-injects the guidance in the same turn after a mid-turn compaction', async ({ agent: ctx, model }) => {
    model.script(
      call('TodoList', { todos: [{ title: 'keep going', status: 'in_progress' }] }, { id: 'call_todo' }),
      say('done'),
    );
    model.lane('compaction').script(say('Mid-turn summary.'));
    await ctx.restorePersisted();
    const loop = ctx.get(IAgentLoopService);
    const compaction = ctx.get(IAgentFullCompactionService);
    const hook = loop.hooks.onWillBeginStep.register('test-mid-turn-compaction', async (stepCtx, next) => {
      if (stepCtx.step === 2) {
        compaction.begin({ source: 'auto' });
        await compaction.compacting?.promise;
      }
      await next();
    }, { after: 'full-compaction' });

    try {
      await runPrompt(ctx, 'start');
    } finally {
      hook.dispose();
    }

    const requests = model.requests('main');
    expect(requests).toHaveLength(2);
    expect(guidanceCount(requests[0])).toBe(1);
    expect(guidanceCount(requests[1])).toBe(1);
    expect(guidanceReminders(ctx)).toHaveLength(1);
  });
});
