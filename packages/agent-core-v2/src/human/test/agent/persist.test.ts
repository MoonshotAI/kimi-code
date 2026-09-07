import { describe, expect, it, vi } from 'vitest';
import { createActor, waitFor } from 'xstate';

import { collectPluginTools, connectPlugins } from '#/plugin';
import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import {
  createAssistantMessage,
  createUserMessage,
  type AssistantMessage,
  type Message,
  type ToolCall,
} from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { createLlmMachine } from '#/llm/requester/machine';
import type { LlmRequester } from '#/llm/requester/requester';
import { createAgentMachine } from '#/agent/machine';
import { loadAgentState, type TurnEntryData } from '#/agent/replay';
import { persistAgent } from '#/persist/agent';
import { createTurnMachine } from '#/agent/turn';
import { MemoryBackend } from '#/store/backend/memory';
import type { Branch } from '#/store/branch';
import { TreeStore } from '#/store/store';
import type { EntryLine } from '#/store/types';
import { createTodoPlugin } from '#/todo/plugin';
import { restoreTodoState, snapshotTodoState } from '#/todo/state';
import { defineTool, type ToolDefinition } from '#/tool/tool';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

function toolCall(id: string, name: string, args: string = '{}'): ToolCall {
  return { type: 'function', id, name, arguments: args };
}

function createStubRequester(responses: readonly AssistantMessage[]): LlmRequester {
  let call = 0;
  return {
    generate: (_config, _content, { onEvent }) => {
      const message = responses[Math.min(call, responses.length - 1)] as AssistantMessage;
      call += 1;
      for (const part of [...message.content, ...message.toolCalls]) {
        onEvent?.({ type: 'llm.delta', part });
      }
      onEvent?.({ type: 'llm.done' });
      return Promise.resolve();
    },
  };
}

function createTestAgentMachine(tools: readonly ToolDefinition[], requester: LlmRequester) {
  return createAgentMachine({
    tools,
    turnActor: createTurnMachine(createLlmMachine({ requester })),
  });
}

const okTool = defineTool({
  name: 'ok_tool',
  description: 'stub ok tool',
  parameters: { type: 'object', properties: {} },
  execute: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
});

async function branchOf(store: TreeStore, tree: string, branch: string): Promise<Branch> {
  const loaded = await store.tree(tree);
  return loaded.has(branch) ? loaded.openBranch(branch) : loaded.createBranch(branch);
}

async function entriesOf(store: TreeStore, tree: string, branch: string): Promise<EntryLine[]> {
  const loaded = await store.tree(tree);
  return [...loaded.openBranch(branch).walk()].toReversed();
}

function entryTypes(entries: readonly EntryLine[]): string[] {
  return entries.map((entry) => entry.type);
}

function turnData(entry: EntryLine): TurnEntryData {
  return entry.payload.data as TurnEntryData;
}

async function waitForEntries(
  store: TreeStore,
  tree: string,
  branch: string,
  count: number,
): Promise<EntryLine[]> {
  let entries: EntryLine[] = [];
  await vi.waitFor(async () => {
    entries = await entriesOf(store, tree, branch);
    expect(entries).toHaveLength(count);
  });
  return entries;
}

describe('persistAgent', () => {
  it('persists messages and turn boundaries in order', async () => {
    const fs = new MemoryBackend();
    const store = await TreeStore.open(fs);
    const requester = createStubRequester([
      createAssistantMessage([], [toolCall('call-1', 'ok_tool')]),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    const actor = createActor(createTestAgentMachine([okTool], requester), {
      input: { request: { model } },
    });
    actor.start();
    const handle = persistAgent(actor, await branchOf(store, 'session', 'main'));
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });
    await waitFor(actor, (s) => s.matches('idle') && s.context.messages.length === 4, {
      timeout: 5000,
    });

    const entries = await waitForEntries(store, 'session', 'main', 6);
    expect(entryTypes(entries)).toEqual([
      'message',
      'turn',
      'message',
      'message',
      'message',
      'turn',
    ]);
    expect((entries[0] as EntryLine).payload.data).toMatchObject({
      message: { role: 'user' },
      meta: { source: 'input' },
    });
    expect(turnData(entries[1] as EntryLine)).toEqual({ phase: 'start', turnId: 1 });
    expect(turnData(entries[5] as EntryLine)).toEqual({
      phase: 'end',
      turnId: 1,
      outcome: 'done',
    });
    handle.dispose();
  });

  it('restores messages and turnId without duplicating entries', async () => {
    const fs = new MemoryBackend();
    const store = await TreeStore.open(fs);
    const first = createStubRequester([createAssistantMessage([{ type: 'text', text: 'first' }])]);
    const firstActor = createActor(createTestAgentMachine([okTool], first), {
      input: { request: { model } },
    });
    firstActor.start();
    persistAgent(firstActor, await branchOf(store, 'session', 'main'));
    firstActor.send({ type: 'input.submit', message: createUserMessage('hi') });
    const firstSnapshot = await waitFor(
      firstActor,
      (s) => s.matches('idle') && s.context.messages.length === 2,
      { timeout: 5000 },
    );
    await waitForEntries(store, 'session', 'main', 4);

    const reopened = await TreeStore.open(fs);
    const loaded = await loadAgentState(await reopened.tree('session'), 'main');
    expect(loaded.messages).toEqual(firstSnapshot.context.messages);
    expect(loaded.turnId).toBe(1);

    const second = createStubRequester([createAssistantMessage([{ type: 'text', text: 'second' }])]);
    const secondActor = createActor(createTestAgentMachine([okTool], second), {
      input: { request: { model }, history: loaded.messages, turnId: loaded.turnId },
    });
    secondActor.start();
    persistAgent(secondActor, await branchOf(reopened, 'session', 'main'));
    secondActor.send({ type: 'input.submit', message: createUserMessage('again') });
    const secondSnapshot = await waitFor(
      secondActor,
      (s) => s.matches('idle') && s.context.messages.length === 4,
      { timeout: 5000 },
    );

    const entries = await waitForEntries(reopened, 'session', 'main', 8);
    const messageEntries = entries.filter((entry) => entry.type === 'message');
    expect(messageEntries.map((entry) => entry.payload.data)).toEqual(
      secondSnapshot.context.messages,
    );
    const starts = entries
      .filter((entry) => entry.type === 'turn')
      .map((entry) => turnData(entry))
      .filter((data) => data.phase === 'start');
    expect(starts).toEqual([
      { phase: 'start', turnId: 1 },
      { phase: 'start', turnId: 2 },
    ]);
  });

  it('persists and restores todo state', async () => {
    const fs = new MemoryBackend();
    const store = await TreeStore.open(fs);
    const todo = createTodoPlugin();
    const tools = collectPluginTools([todo]);
    const requester = createStubRequester([
      createAssistantMessage(
        [],
        [
          toolCall(
            'call-todo',
            'TodoList',
            JSON.stringify({ todos: [{ title: 'task a', status: 'in_progress' }] }),
          ),
        ],
      ),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    const actor = createActor(createTestAgentMachine(tools, requester), {
      input: { request: { model } },
    });
    connectPlugins(actor, [todo]);
    actor.start();
    persistAgent(actor, await branchOf(store, 'session', 'main'), {
      states: { todo: () => snapshotTodoState(todo.state) },
    });
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });
    await waitFor(actor, (s) => s.matches('idle') && s.context.messages.length === 4, {
      timeout: 5000,
    });

    const entries = await waitForEntries(store, 'session', 'main', 7);
    expect(entryTypes(entries)).toEqual([
      'message',
      'turn',
      'state',
      'message',
      'message',
      'message',
      'turn',
    ]);
    const stateEntry = entries.find((entry) => entry.type === 'state') as EntryLine;
    expect(stateEntry.payload.data).toEqual({
      name: 'todo',
      value: { todos: [{ title: 'task a', status: 'in_progress' }], lastWriteTurn: 1 },
    });

    const reopened = await TreeStore.open(fs);
    const loaded = await loadAgentState(await reopened.tree('session'), 'main');
    const restored = restoreTodoState(loaded.states['todo'], loaded.turnId);
    expect(restored.todos).toEqual([{ title: 'task a', status: 'in_progress' }]);
    expect(restored.lastWriteTurn).toBe(1);
    expect(restored.currentTurn).toBe(1);
  });

  it('restores offloaded messages through blob refs', async () => {
    const fs = new MemoryBackend();
    const store = await TreeStore.open(fs, { offloadThreshold: 1 });
    const requester = createStubRequester([
      createAssistantMessage([{ type: 'text', text: 'a fairly long reply' }]),
    ]);
    const actor = createActor(createTestAgentMachine([okTool], requester), {
      input: { request: { model } },
    });
    actor.start();
    persistAgent(actor, await branchOf(store, 'session', 'main'));
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 2,
      { timeout: 5000 },
    );
    await waitForEntries(store, 'session', 'main', 4);

    const reopened = await TreeStore.open(fs);
    const loaded = await loadAgentState(await reopened.tree('session'), 'main');
    expect(loaded.messages).toEqual(snapshot.context.messages);
    expect(loaded.turnId).toBe(1);
  });
});
