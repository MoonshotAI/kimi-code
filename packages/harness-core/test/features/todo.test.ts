import { describe, expect, it } from 'vitest';

import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import { createAssistantMessage, createUserMessage, extractText, type ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';

import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  undoAgentTurns,
  type Harness,
} from '#/runtime/index';
import {
  todo,
  TodoRef,
  TODO_LIST_TOOL_NAME,
  TODO_UPDATED,
  type TodoFace,
  type TodoUpdatedEvent,
} from '#/features/todo/index';

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function scriptedRequester(next: (rest: GenerateRest) => LlmOutcome | Promise<LlmOutcome>): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest, _control) => next(rest),
  };
  return self;
}

function todoTurnsRequester(turns: readonly (readonly string[] | null)[]): LoopLlmRequester {
  return scriptedRequester((rest) => {
    const messages = rest.content?.messages ?? [];
    const last = messages.at(-1);
    if (last !== undefined && last.role === 'tool') return textOutcome('done');
    const turnIndex = messages.filter((message) => message.role === 'user').length - 1;
    const titles = turns[turnIndex];
    if (titles === null || titles === undefined) return textOutcome('plain');
    return textOutcome('writing', [
      {
        type: 'function',
        id: `todo-${turnIndex}`,
        name: TODO_LIST_TOOL_NAME,
        arguments: JSON.stringify({
          todos: titles.map((title) => ({ title, status: 'in_progress' })),
        }),
      },
    ]);
  });
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function captureFacade(): { feature: Feature<void>; face: () => TodoFace | undefined } {
  let exposed: Readonly<ShallowRef<TodoFace | undefined>> | undefined;
  const feature = createFeature('todo-probe', {
    agent: () => {
      exposed = useInject(TodoRef);
    },
  });
  return { feature, face: () => exposed?.value };
}

describe('todo feature', () => {
  it('writes todos through the TodoList tool, folds state, fires events and reminds when stale', async () => {
    const harness = createHarness({ space: memoryHarnessSpace() });
    const probe = captureFacade();
    await harness.app.features.add(todo);
    await harness.app.features.add(probe.feature);
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main');
    setRequester(harness, 's1', 'main', todoTurnsRequester([['read code', 'add tests'], null, null, null]));
    const updated: TodoUpdatedEvent[] = [];
    harness.app.on(todo, TODO_UPDATED, (event) => updated.push(event));
    const reminded: string[] = [];
    agent.loop.subscribe((event) => {
      if (event.type === 'prompt.reminded') reminded.push(extractText(event.entry.message));
    });

    const first = await agent.loop.runTurn(user('start'));
    expect(first.type).toBe('done');
    await agent.flush();

    const toolTexts = agent.view
      .getState()
      .messages.filter((entry) => entry.message.role === 'tool')
      .map((entry) => extractText(entry.message));
    expect(toolTexts).toHaveLength(1);
    expect(toolTexts[0]).toContain('Todo list updated.');
    expect(toolTexts[0]).toContain('[in_progress] read code');

    expect(updated).toHaveLength(1);
    expect(updated[0]?.todos).toEqual([
      { title: 'read code', status: 'in_progress' },
      { title: 'add tests', status: 'in_progress' },
    ]);
    expect(updated[0]?.turnId).toBe(0);

    expect(probe.face()?.items.value).toEqual([
      { title: 'read code', status: 'in_progress' },
      { title: 'add tests', status: 'in_progress' },
    ]);
    expect(probe.face()?.state.value.lastWriteTurnId).toBe(0);

    await agent.loop.runTurn(user('continue'));
    await agent.loop.runTurn(user('continue more'));
    expect(reminded).toHaveLength(1);
    expect(reminded[0]).toContain('todo list has not been updated recently');
    expect(reminded[0]).toContain('read code');

    await agent.loop.runTurn(user('keep going'));
    expect(reminded).toHaveLength(1);
    await harness.close();
  });

  it('restores todos across reopen and rewinds them with undo', async () => {
    const space = memoryHarnessSpace();
    const harness = createHarness({ space });
    const probe = captureFacade();
    await harness.app.features.add(todo);
    await harness.app.features.add(probe.feature);
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main');
    setRequester(harness, 's1', 'main', todoTurnsRequester([['task-a'], ['task-b']]));
    await agent.loop.runTurn(user('one'));
    await agent.loop.runTurn(user('two'));
    await agent.flush();
    expect(probe.face()?.items.value).toEqual([{ title: 'task-b', status: 'in_progress' }]);

    await harness.app.close('s1');
    const resumed = await harness.app.create({ sessionId: 's1' });
    const agent2 = await harness.ensureAgent(resumed, 'main');
    await tick();
    expect(probe.face()?.items.value).toEqual([{ title: 'task-b', status: 'in_progress' }]);

    await undoAgentTurns(harness.app, resumed, 'main', 1);
    expect(probe.face()?.items.value).toEqual([{ title: 'task-a', status: 'in_progress' }]);
    const userTexts = agent2.view
      .getState()
      .messages.filter((entry) => entry.message.role === 'user')
      .map((entry) => extractText(entry.message));
    expect(userTexts).toEqual(['one']);
    await harness.close();
  });
});
