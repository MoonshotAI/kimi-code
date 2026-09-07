import { describe, expect, it, vi } from 'vitest';

import { createActor, waitFor, type ActorRefFrom } from '#/xstate2';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createAssistantMessage, createUserMessage, extractText, type AssistantMessage, type Message, type ToolCall } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { createLlmMachine } from '#/llm/requester/machine';
import type { LlmRequester } from '#/llm/requester/requester';
import { createAgentMachine } from '#/agent/machine';
import { createTurnMachine, toInputMessages, type HistoryMessage } from '#/agent/turn';
import {
  createSessionMachine,
  type AgentActorRef,
} from '#/session/machine';
import { undoAgentTurns } from '#/session/undo';
import { loadSessionState, persistSession } from '#/persist/session';
import { collectPluginTools, connectPlugins } from '#/plugin';
import { createTodoPlugin } from '#/todo/plugin';
import { restoreTodoState, snapshotTodoState } from '#/todo/state';
import { MemoryBackend } from '#/store/backend/memory';
import type { Branch } from '#/store/branch';
import type { Tree } from '#/store/tree';
import { TreeStore } from '#/store/store';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

type SessionActor = ActorRefFrom<ReturnType<typeof createSessionMachine>>;

function toolCall(id: string, name: string, args: string = '{}'): ToolCall {
  return { type: 'function', id, name, arguments: args };
}

function createStubRequester(responses: readonly AssistantMessage[]): LlmRequester {
  let call = 0;
  return {
    generate: (_config, _content, { onEvent }) => {
      const message = responses[Math.min(call, responses.length - 1)];
      call += 1;
      for (const part of [...message.content, ...message.toolCalls]) {
        onEvent?.({ type: 'llm.delta', part });
      }
      onEvent?.({ type: 'llm.done' });
      return Promise.resolve();
    },
  };
}

function createEchoRequester(): LlmRequester {
  return {
    generate: (_config, { messages }, { onEvent }) => {
      const last = messages.at(-1);
      const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
      onEvent?.({ type: 'llm.delta', part: { type: 'text', text: `echo:${text}` } });
      onEvent?.({ type: 'llm.done' });
      return Promise.resolve();
    },
  };
}

function createTestSession(requester: LlmRequester): SessionActor {
  const session = createActor(
    createSessionMachine({
      agent: createAgentMachine({
        tools: [],
        turnActor: createTurnMachine(createLlmMachine({ requester })),
      }),
    }),
    { input: { request: { model } } },
  );
  session.start();
  return session;
}

function agentRef(session: SessionActor, agentId: string): AgentActorRef {
  const entry = session.getSnapshot().context.agents[agentId];
  expect(entry).toBeDefined();
  return (entry as { ref: AgentActorRef }).ref;
}

function submit(session: SessionActor, agentId: string, text: string): void {
  session.send({
    type: 'agent.send',
    agentId,
    event: { type: 'input.submit', message: createUserMessage(text) },
  });
}

function chainMessages(branch: Branch): Message[] {
  return toInputMessages(
    [...branch.walk()]
      .toReversed()
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.payload.data as HistoryMessage),
  );
}

async function restoreSession(
  tree: Tree,
): Promise<{
  session: SessionActor;
  loaded: Awaited<ReturnType<typeof loadSessionState>>;
  persistence: ReturnType<typeof persistSession>;
}> {
  const loaded = await loadSessionState(tree);
  const session = createTestSession(createEchoRequester());
  const persistence = persistSession(session, tree, {
    branches: new Map(loaded.agents.map((agent) => [agent.agentId, agent.branch])),
  });
  for (const agent of loaded.agents) {
    session.send({
      type: 'agent.create',
      agentId: agent.agentId,
      input: { history: agent.messages, turnId: agent.turnId, branchId: agent.branch },
    });
  }
  return { session, loaded, persistence };
}

describe('persistSession', () => {
  it('persists and restores a full session with a forked agent', async () => {
    const fs = new MemoryBackend();
    const store = await TreeStore.open(fs);
    const tree = await store.tree('sess');
    const session = createTestSession(createEchoRequester());
    const persistence = persistSession(session, tree);

    session.send({ type: 'agent.create', agentId: 'main' });
    submit(session, 'main', 'hi');
    await waitFor(agentRef(session, 'main'), (s) => s.matches('idle') && s.context.messages.length === 2, {
      timeout: 5000,
    });
    await persistence.flush();

    session.send({ type: 'agent.fork', sourceId: 'main', agentId: 'fork' });
    submit(session, 'fork', 'fork-hi');
    submit(session, 'main', 'main-hi');
    await waitFor(agentRef(session, 'main'), (s) => s.matches('idle') && s.context.messages.length === 4, {
      timeout: 5000,
    });
    await waitFor(agentRef(session, 'fork'), (s) => s.matches('idle') && s.context.messages.length === 4, {
      timeout: 5000,
    });
    await persistence.flush();

    expect(tree.branches()).toEqual(['_session', 'fork', 'main']);
    const mainBranch = tree.openBranch('main');
    const forkBranch = tree.openBranch('fork');
    expect(forkBranch.header.parentBranch).toBe('main');
    expect(forkBranch.header.parentSeq).toBe(3);
    expect(chainMessages(mainBranch).map(extractText)).toEqual([
      'hi',
      'echo:hi',
      'main-hi',
      'echo:main-hi',
    ]);
    expect(chainMessages(forkBranch).map(extractText)).toEqual([
      'hi',
      'echo:hi',
      'fork-hi',
      'echo:fork-hi',
    ]);
    expect(forkBranch.nextSeq).toBe(4);

    await persistence.flush();
    persistence.dispose();
    session.stop();

    const reopened = await TreeStore.open(fs);
    const { session: restored, loaded, persistence: restoredPersistence } = await restoreSession(
      await reopened.tree('sess'),
    );
    expect(loaded.agents.map((agent) => agent.agentId).sort()).toEqual(['fork', 'main']);
    for (const agent of loaded.agents) {
      expect(agent.turnId).toBe(2);
      expect(agentRef(restored, agent.agentId).getSnapshot().context.messages).toEqual(agent.messages);
    }

    submit(restored, 'main', 'again');
    await waitFor(agentRef(restored, 'main'), (s) => s.matches('idle') && s.context.messages.length === 6, {
      timeout: 5000,
    });
    await restoredPersistence.flush();
    const mainMessages = chainMessages((await reopened.tree('sess')).openBranch('main'));
    expect(mainMessages.map(extractText)).toEqual([
      'hi',
      'echo:hi',
      'main-hi',
      'echo:main-hi',
      'again',
      'echo:again',
    ]);
  });

  it('skips cleanly stopped agents on restore', async () => {
    const fs = new MemoryBackend();
    const store = await TreeStore.open(fs);
    const tree = await store.tree('sess');
    const session = createTestSession(createEchoRequester());
    const persistence = persistSession(session, tree);

    session.send({ type: 'agent.create', agentId: 'main' });
    session.send({ type: 'agent.create', agentId: 'temp' });
    submit(session, 'main', 'hi');
    submit(session, 'temp', 'temp-hi');
    await waitFor(agentRef(session, 'temp'), (s) => s.matches('idle') && s.context.messages.length === 2, {
      timeout: 5000,
    });
    await waitFor(agentRef(session, 'main'), (s) => s.matches('idle') && s.context.messages.length === 2, {
      timeout: 5000,
    });
    session.send({ type: 'agent.stop', agentId: 'temp' });
    await persistence.flush();

    const logEntries = [...tree.openBranch('_session').walk()]
      .toReversed()
      .map((entry) => `${entry.type}:${(entry.payload.data as { agentId: string }).agentId}`);
    expect(logEntries).toEqual(['agent.open:main', 'agent.open:temp', 'agent.close:temp']);

    persistence.dispose();
    session.stop();

    const reopened = await TreeStore.open(fs);
    const loaded = await loadSessionState(await reopened.tree('sess'));
    expect(loaded.agents.map((agent) => agent.agentId)).toEqual(['main']);
  });

  it('gives a recreated anonymous agent a fresh branch', async () => {
    const fs = new MemoryBackend();
    const store = await TreeStore.open(fs);
    const tree = await store.tree('sess');
    const session = createTestSession(createEchoRequester());
    const persistence = persistSession(session, tree);

    session.send({ type: 'agent.create' });
    submit(session, 'agent-1', 'hi');
    await waitFor(agentRef(session, 'agent-1'), (s) => s.matches('idle') && s.context.messages.length === 2, {
      timeout: 5000,
    });
    session.send({ type: 'agent.stop', agentId: 'agent-1' });
    await persistence.flush();
    persistence.dispose();
    session.stop();

    const reopened = await TreeStore.open(fs);
    const loaded = await loadSessionState(await reopened.tree('sess'));
    expect(loaded.agents).toEqual([]);

    const restored = createTestSession(createEchoRequester());
    const restoredPersistence = persistSession(restored, await reopened.tree('sess'));
    restored.send({ type: 'agent.create', input: { branchId: 'agent-1~2' } });
    submit(restored, 'agent-1', 'fresh');
    await waitFor(agentRef(restored, 'agent-1'), (s) => s.matches('idle') && s.context.messages.length === 2, {
      timeout: 5000,
    });
    await restoredPersistence.flush();

    const branches = (await reopened.tree('sess')).branches();
    expect(branches).toEqual(['_session', 'agent-1', 'agent-1~2']);
    expect(chainMessages((await reopened.tree('sess')).openBranch('agent-1~2')).map(extractText)).toEqual([
      'fresh',
      'echo:fresh',
    ]);
  });
});


describe('undoAgentTurns', () => {
  it('undoes the last turn by switching to a forked branch and restores it after reopen', async () => {
    const fs = new MemoryBackend();
    const store = await TreeStore.open(fs);
    const tree = await store.tree('sess');
    const session = createTestSession(createEchoRequester());
    const persistence = persistSession(session, tree);

    session.send({ type: 'agent.create', agentId: 'main' });
    submit(session, 'main', 'first');
    await waitFor(agentRef(session, 'main'), (s) => s.matches('idle') && s.context.messages.length === 2, {
      timeout: 5000,
    });
    submit(session, 'main', 'second');
    await waitFor(agentRef(session, 'main'), (s) => s.matches('idle') && s.context.messages.length === 4, {
      timeout: 5000,
    });
    await persistence.flush();

    const result = await undoAgentTurns(session, tree, 'main', 1);
    expect(result.branchId).toBe('main~2');
    expect(result.turnId).toBe(1);
    expect(toInputMessages(result.messages).map(extractText)).toEqual(['first', 'echo:first']);

    const snapshot = agentRef(session, 'main').getSnapshot();
    expect(snapshot.context.branchId).toBe('main~2');
    expect(snapshot.context.turnId).toBe(1);
    expect(snapshot.context.messages).toHaveLength(2);

    const undoBranch = tree.openBranch('main~2');
    expect(undoBranch.header.parentBranch).toBe('main');
    expect(undoBranch.header.parentSeq).toBe(3);
    expect(chainMessages(tree.openBranch('main')).map(extractText)).toEqual([
      'first',
      'echo:first',
      'second',
      'echo:second',
    ]);

    submit(session, 'main', 'third');
    await waitFor(agentRef(session, 'main'), (s) => s.matches('idle') && s.context.messages.length === 4, {
      timeout: 5000,
    });
    await persistence.flush();
    expect(chainMessages(undoBranch).map(extractText)).toEqual([
      'first',
      'echo:first',
      'third',
      'echo:third',
    ]);
    expect(chainMessages(tree.openBranch('main')).map(extractText)).toHaveLength(4);

    const logEntries = [...tree.openBranch('_session').walk()].toReversed();
    expect(logEntries.map((entry) => entry.type)).toEqual(['agent.open', 'agent.switch']);
    expect(logEntries[1]?.payload.data).toMatchObject({
      agentId: 'main',
      branch: 'main~2',
      reason: 'undo',
      from: { branch: 'main', seq: 7 },
    });

    persistence.dispose();
    session.stop();

    const reopened = await TreeStore.open(fs);
    const { session: restored, loaded } = await restoreSession(await reopened.tree('sess'));
    expect(loaded.agents).toHaveLength(1);
    expect(loaded.agents[0]?.branch).toBe('main~2');
    expect(loaded.agents[0]?.turnId).toBe(2);
    expect(toInputMessages(loaded.agents[0]?.messages ?? []).map(extractText)).toEqual([
      'first',
      'echo:first',
      'third',
      'echo:third',
    ]);
    expect(agentRef(restored, 'main').getSnapshot().context.branchId).toBe('main~2');
  });

  it('rejects undo when anchors are insufficient or the agent is busy', async () => {
    const fs = new MemoryBackend();
    const store = await TreeStore.open(fs);
    const tree = await store.tree('sess');
    let release: (() => void) | undefined;
    const requester: LlmRequester = {
      generate: (_config, _content, { onEvent }) =>
        new Promise<void>((resolve) => {
          release = () => {
            onEvent?.({ type: 'llm.delta', part: { type: 'text', text: 'late' } });
            onEvent?.({ type: 'llm.done' });
            resolve();
          };
        }),
    };
    const session = createTestSession(requester);
    persistSession(session, tree);
    session.send({ type: 'agent.create', agentId: 'main' });

    await expect(undoAgentTurns(session, tree, 'main', 1)).rejects.toMatchObject({
      reason: 'insufficient',
    });

    submit(session, 'main', 'hi');
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(undoAgentTurns(session, tree, 'main', 1)).rejects.toMatchObject({ reason: 'busy' });
    release?.();
    await waitFor(agentRef(session, 'main'), (s) => s.matches('idle'), { timeout: 5000 });

    await expect(undoAgentTurns(session, tree, 'main', 5)).rejects.toMatchObject({
      reason: 'insufficient',
    });
    await expect(undoAgentTurns(session, tree, 'nope', 1)).rejects.toMatchObject({
      reason: 'unknown-agent',
    });
    await expect(undoAgentTurns(session, tree, 'main', 0)).rejects.toMatchObject({
      reason: 'invalid-count',
    });
  });

  it('rolls back plugin state from the undo result', async () => {
    const fs = new MemoryBackend();
    const store = await TreeStore.open(fs);
    const tree = await store.tree('sess');
    const todo = createTodoPlugin();
    const tools = collectPluginTools([todo]);
    const requester = createStubRequester([
      createAssistantMessage(
        [],
        [
          toolCall(
            'call-todo-1',
            'TodoList',
            JSON.stringify({ todos: [{ title: 'task a', status: 'in_progress' }] }),
          ),
        ],
      ),
      createAssistantMessage([{ type: 'text', text: 'noted' }]),
      createAssistantMessage(
        [],
        [
          toolCall(
            'call-todo-2',
            'TodoList',
            JSON.stringify({ todos: [{ title: 'task a', status: 'done' }] }),
          ),
        ],
      ),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ]);
    const session = createActor(
      createSessionMachine({
        agent: createAgentMachine({
          tools,
          turnActor: createTurnMachine(createLlmMachine({ requester })),
        }),
      }),
      { input: { request: { model } } },
    );
    session.start();
    persistSession(session, tree, {
      states: () => ({ todo: () => snapshotTodoState(todo.state) }),
    });
    session.send({ type: 'agent.create', agentId: 'main' });
    connectPlugins(agentRef(session, 'main'), [todo]);

    submit(session, 'main', 'hi');
    await waitFor(agentRef(session, 'main'), (s) => s.matches('idle') && s.context.messages.length === 4, {
      timeout: 5000,
    });
    expect(todo.state.todos).toEqual([{ title: 'task a', status: 'in_progress' }]);

    submit(session, 'main', 'finish');
    await waitFor(agentRef(session, 'main'), (s) => s.matches('idle') && s.context.messages.length === 8, {
      timeout: 5000,
    });
    expect(todo.state.todos).toEqual([{ title: 'task a', status: 'done' }]);

    const result = await undoAgentTurns(session, tree, 'main', 1);
    expect(result.states['todo']).toMatchObject({
      todos: [{ title: 'task a', status: 'in_progress' }],
      lastWriteTurn: 1,
    });

    Object.assign(todo.state, restoreTodoState(result.states['todo'], result.turnId));
    expect(todo.state.todos).toEqual([{ title: 'task a', status: 'in_progress' }]);
    expect(todo.state.currentTurn).toBe(1);
  });

  it('undoes twice by descending the parent chain', async () => {
    const fs = new MemoryBackend();
    const store = await TreeStore.open(fs);
    const tree = await store.tree('sess');
    const session = createTestSession(createEchoRequester());
    const persistence = persistSession(session, tree);

    session.send({ type: 'agent.create', agentId: 'main' });
    submit(session, 'main', 'one');
    await waitFor(agentRef(session, 'main'), (s) => s.matches('idle') && s.context.messages.length === 2, {
      timeout: 5000,
    });
    submit(session, 'main', 'two');
    await waitFor(agentRef(session, 'main'), (s) => s.matches('idle') && s.context.messages.length === 4, {
      timeout: 5000,
    });
    submit(session, 'main', 'three');
    await waitFor(agentRef(session, 'main'), (s) => s.matches('idle') && s.context.messages.length === 6, {
      timeout: 5000,
    });
    await persistence.flush();

    const first = await undoAgentTurns(session, tree, 'main', 1);
    expect(first.branchId).toBe('main~2');
    expect(toInputMessages(first.messages).map(extractText)).toEqual([
      'one',
      'echo:one',
      'two',
      'echo:two',
    ]);

    submit(session, 'main', 'three-alt');
    await waitFor(agentRef(session, 'main'), (s) => s.matches('idle') && s.context.messages.length === 6, {
      timeout: 5000,
    });
    await persistence.flush();

    const second = await undoAgentTurns(session, tree, 'main', 2);
    expect(second.branchId).toBe('main~3');
    expect(second.turnId).toBe(1);
    expect(toInputMessages(second.messages).map(extractText)).toEqual(['one', 'echo:one']);
    const secondBranch = tree.openBranch('main~3');
    expect(secondBranch.header.parentBranch).toBe('main');
    expect(secondBranch.header.parentSeq).toBe(3);
  });
});
