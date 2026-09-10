import { describe, expect, it } from 'vitest';

import { turnStarted } from '#/agent/events';
import { agentSlices, type AgentEventStore } from '#/agent/slices';
import { createEventStoreSync } from '#/eventStore/eventStore';
import { memoryJournal } from '#/eventStore/journal';
import { extractText, type SystemMessage, type ToolCall, type UserMessage } from '#/llm/message';
import type { AgentEmitted } from '#/agent/machine';
import { connectPlugins, type AgentPluginTarget, type Plugin } from '#/plugin';
import type { ToolExecuteInput } from '#/tool/executor';
import type { ToolDefinition } from '#/tool/tool';
import { createTodoPlugin, type TodoPlugin } from '#/todo/plugin';
import { todoSlice } from '#/todo/slice';

function testStore(): AgentEventStore {
  return createEventStoreSync({
    journal: memoryJournal(),
    slices: { ...agentSlices, todo: todoSlice },
  }) as AgentEventStore;
}

function toolCall(args: unknown): ToolCall {
  return { type: 'function', id: 'call-1', name: 'TodoList', arguments: JSON.stringify(args) };
}

function executeInput(args: unknown): ToolExecuteInput {
  return { toolCall: toolCall(args), signal: new AbortController().signal };
}

function pluginTool(plugin: TodoPlugin): ToolDefinition {
  const tool = plugin.tools()[0];
  if (tool === undefined) throw new Error('expected the todo plugin to provide a tool');
  return tool;
}

function createTarget(store: AgentEventStore) {
  const handlers: ((event: AgentEmitted) => void)[] = [];
  const notified: UserMessage[] = [];
  const reminded: { key: string; message: UserMessage | SystemMessage }[] = [];
  const target: AgentPluginTarget = {
    kind: 'agent',
    on: (_type, handler) => {
      handlers.push(handler);
    },
    notify: (message) => {
      notified.push(message);
    },
    remind: (key, message) => {
      reminded.push({ key, message });
    },
  };
  let turnId = 0;
  const turnStart = async () => {
    await store.dispatch(turnStarted({ turnId }));
    turnId += 1;
    for (const handler of handlers) {
      handler({ type: 'turn.started', turnId, branchId: 'main' });
    }
  };
  return { target, notified, reminded, turnStart };
}

describe('todo plugin tool', () => {
  it('reads an empty list', async () => {
    const plugin = createTodoPlugin(testStore());
    const result = await pluginTool(plugin).execute(executeInput({}));
    expect(result.content).toEqual([{ type: 'text', text: 'Todo list is empty.' }]);
  });

  it('replaces the list and reads it back', async () => {
    const plugin = createTodoPlugin(testStore());
    const result = await pluginTool(plugin).execute(
      executeInput({
        todos: [
          { title: 'task a', status: 'in_progress' },
          { title: 'task b', status: 'pending' },
        ],
      }),
    );
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('Todo list updated.') },
    ]);
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('[in_progress] task a') },
    ]);

    const read = await pluginTool(plugin).execute(executeInput({}));
    expect(read.content).toEqual([
      { type: 'text', text: 'Current todo list:\n  [in_progress] task a\n  [pending] task b' },
    ]);
  });

  it('clears the list with an empty array', async () => {
    const plugin = createTodoPlugin(testStore());
    await pluginTool(plugin).execute(executeInput({ todos: [{ title: 'task a', status: 'pending' }] }));
    const result = await pluginTool(plugin).execute(executeInput({ todos: [] }));
    expect(result.content).toEqual([{ type: 'text', text: 'Todo list cleared.' }]);

    const read = await pluginTool(plugin).execute(executeInput({}));
    expect(read.content).toEqual([{ type: 'text', text: 'Todo list is empty.' }]);
  });

  it('drops malformed items on write', async () => {
    const plugin = createTodoPlugin(testStore());
    await pluginTool(plugin).execute(
      executeInput({
        todos: [{ title: 'task a' }, { title: 'task b', status: 'done' }, 'junk'],
      }),
    );
    const read = await pluginTool(plugin).execute(executeInput({}));
    expect(read.content).toEqual([
      { type: 'text', text: 'Current todo list:\n  [done] task b' },
    ]);
  });
});

describe('todo plugin reminder', () => {
  it('notifies once when the list goes stale', async () => {
    const store = testStore();
    const plugin = createTodoPlugin(store);
    const { target, notified, turnStart } = createTarget(store);
    plugin.connect?.(target);

    await turnStart();
    await pluginTool(plugin).execute(executeInput({ todos: [{ title: 'task a', status: 'pending' }] }));

    await turnStart();
    expect(notified).toHaveLength(0);

    await turnStart();
    expect(notified).toHaveLength(1);
    const text = extractText(notified[0]);
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('[pending] task a');

    await turnStart();
    expect(notified).toHaveLength(1);
  });

  it('stays silent when every item is done', async () => {
    const store = testStore();
    const plugin = createTodoPlugin(store);
    const { target, notified, turnStart } = createTarget(store);
    plugin.connect?.(target);

    await turnStart();
    await pluginTool(plugin).execute(executeInput({ todos: [{ title: 'task a', status: 'done' }] }));
    await turnStart();
    await turnStart();
    expect(notified).toHaveLength(0);
  });

  it('stays silent while the list is empty', async () => {
    const store = testStore();
    const plugin = createTodoPlugin(store);
    const { target, notified, turnStart } = createTarget(store);
    plugin.connect?.(target);

    await turnStart();
    await turnStart();
    await turnStart();
    expect(notified).toHaveLength(0);
  });
});

describe('connectPlugins notify channel', () => {
  it('maps target.notify to an input.notify event on the actor', () => {
    const sent: unknown[] = [];
    const plugin = createTodoPlugin(testStore());
    const probe: Plugin = {
      name: 'probe',
      tools: () => [],
      connect(target) {
        if (target.kind !== 'agent') return;
        target.notify({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
      },
    };
    connectPlugins(
      {
        on: () => undefined,
        send: (event) => {
          sent.push(event);
        },
      },
      [probe],
    );
    expect(plugin.name).toBe('todo');
    expect(sent).toEqual([
      {
        type: 'input.notify',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      },
    ]);
  });
});
