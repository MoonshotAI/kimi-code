import { describe, expect, it, vi } from 'vitest';
import { createActor, waitFor, type ActorRefFrom } from '#/xstate2';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
} from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import type { LlmRequester } from '#/llm/requester/requester';
import { emptyUsage } from '#/llm/usage';
import { createAgentMachine, type AgentInput } from '#/agent/machine';
import { messageAppended, turnEnded } from '#/agent/events';
import { agentSlices, type AgentEventStore } from '#/agent/slices';
import {
  createAssistantEntry,
  createUserEntry,
  toInputMessages,
  type HistoryMessage,
} from '#/agent/turn';
import {
  createSessionMachine,
  type AgentActorRef,
} from '#/session/machine';
import { createEventStore } from '#/eventStore/eventStore';
import { journalFromBranch } from '#/eventStore/journal';
import { MemoryBackend } from '#/store/backend/memory';
import { TreeStore } from '#/store/store';
import type { BranchRef } from '#/store/types';
import type { Tree } from '#/store/tree';
import { testScopeFactory } from '#/test/agent/scope-factory';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

type SessionActor = ActorRefFrom<ReturnType<typeof createSessionMachine>>;

function createEchoRequester(): LlmRequester {
  return {
    generate: (_config, { messages }, { onEvent }) => {
      const last = messages.at(-1);
      const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
      onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: `echo:${text}` } });
      onEvent?.({ type: 'llm.done' });
      return Promise.resolve();
    },
  };
}

function agentLogic() {
  return createAgentMachine({});
}

function createTestSession(): SessionActor {
  const session = createActor(createSessionMachine(), { input: { request: { model } } });
  session.start();
  return session;
}

function sendCreate(
  session: SessionActor,
  requester: LlmRequester,
  store: AgentEventStore,
  agentId?: string,
): void {
  session.send({
    type: 'agent.create',
    agentId,
    logic: agentLogic(),
    input: { request: { model }, store, scopeFactory: testScopeFactory({ store, requester }) },
  });
}

interface TestEnv {
  tree: Tree;
  open(branch: string, from?: BranchRef): Promise<AgentEventStore>;
}

async function testEnv(): Promise<TestEnv> {
  const backend = new MemoryBackend();
  const store = await TreeStore.open(backend, {});
  const tree = await store.tree('test');
  return {
    tree,
    open: (branch, from) => {
      if (!tree.has(branch)) {
        tree.createBranch(branch, from !== undefined ? { from } : undefined);
      }
      return createEventStore({ journal: journalFromBranch(tree.openBranch(branch), tree), slices: agentSlices });
    },
  };
}

function forkStore(env: TestEnv, source: AgentEventStore, branch: string): Promise<AgentEventStore> {
  const sourceBranch = env.tree.openBranch(source.ref.branch);
  const head = sourceBranch.head;
  return env.open(branch, head === null ? undefined : { branch: sourceBranch.name, seq: head });
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
    event: { type: 'input.submit', entry: { message: createUserMessage(text) } },
  });
}

async function waitIdle(ref: AgentActorRef, store: AgentEventStore, messageCount: number) {
  return waitFor(
    ref,
    (snapshot) => snapshot.matches('idle') && store.getState().history.length === messageCount,
    { timeout: 5000 },
  );
}

function rolesAndTexts(messages: readonly HistoryMessage[]): string[] {
  return toInputMessages(messages).map((message) => `${message.role}:${extractText(message)}`);
}

describe('session machine agent lifecycle', () => {
  it('generates default agent ids for anonymous creates', async () => {
    const session = createTestSession();
    const requester = createEchoRequester();
    const created: Array<{ agentId: string; branchId: string }> = [];
    session.on('agent.created', (event) =>
      created.push({ agentId: event.agentId, branchId: event.branchId }),
    );
    const env = await testEnv();

    sendCreate(session, requester, await env.open('agent-1'));
    sendCreate(session, requester, await env.open('agent-2'));

    expect(created).toEqual([
      { agentId: 'agent-1', branchId: 'agent-1' },
      { agentId: 'agent-2', branchId: 'agent-2' },
    ]);
    expect(Object.keys(session.getSnapshot().context.agents).toSorted()).toEqual(['agent-1', 'agent-2']);
  });

  it('creates a agent with restored messages and turnId', async () => {
    const session = createTestSession();
    const env = await testEnv();
    const store = await env.open('restored');
    await store.dispatch(
      messageAppended({ message: createUserEntry(createUserMessage('old'), { source: 'input' }) }),
    );
    await store.dispatch(
      messageAppended({
        message: createAssistantEntry(createAssistantMessage([{ type: 'text', text: 'echo:old' }]), {
          source: 'llm',
          usage: emptyUsage(),
        }),
      }),
    );
    await store.dispatch(turnEnded({ turnId: 6, outcome: 'done' }));
    sendCreate(session, createEchoRequester(), store, 'restored');

    const ref = agentRef(session, 'restored');
    expect(store.getState().turnIndex.nextTurnId).toBe(7);
    submit(session, 'restored', 'new');
    await waitIdle(ref, store, 4);

    expect(store.getState().turnIndex.nextTurnId).toBe(8);
    expect(rolesAndTexts(store.getState().history)).toEqual([
      'user:old',
      'assistant:echo:old',
      'user:new',
      'assistant:echo:new',
    ]);
  });

  it('rejects a duplicate agent id and keeps the existing agent', async () => {
    const session = createTestSession();
    const requester = createEchoRequester();
    const errors: string[] = [];
    session.on('agent.failed', (event) => errors.push(event.error));
    const env = await testEnv();

    sendCreate(session, requester, await env.open('a'), 'a');
    const first = agentRef(session, 'a');
    sendCreate(session, requester, await env.open('a-dup'), 'a');

    expect(errors).toEqual([`duplicate agent id: 'a'`]);
    expect(agentRef(session, 'a')).toBe(first);
  });

  it('stops a agent and removes it from the registry once the actor reaches disposed', async () => {
    const session = createTestSession();
    const env = await testEnv();
    sendCreate(session, createEchoRequester(), await env.open('a'), 'a');
    const ref = agentRef(session, 'a');
    await waitFor(ref, (snapshot) => snapshot.matches('idle'), { timeout: 5000 });
    const stopped: string[] = [];
    session.on('agent.stopped', (event) => stopped.push(event.agentId));

    session.send({ type: 'agent.stop', agentId: 'a' });

    expect(session.getSnapshot().context.agents['a']).toBeDefined();
    expect(stopped).toEqual([]);
    expect(ref.getSnapshot().status).toBe('active');

    await waitFor(session, (snapshot) => snapshot.context.agents['a'] === undefined, {
      timeout: 5000,
    });

    expect(stopped).toEqual(['a']);
    expect(ref.getSnapshot().status).toBe('done');
  });

  it('emits agent.failed when routing to an unknown agent', async () => {
    const session = createTestSession();
    const errors: string[] = [];
    session.on('agent.failed', (event) => errors.push(event.error));

    submit(session, 'nope', 'hi');
    session.send({ type: 'agent.stop', agentId: 'nope' });
    session.send({ type: 'agent.restart', agentId: 'nope' });

    expect(errors).toEqual([
      `unknown agent: 'nope'`,
      `unknown agent: 'nope'`,
      `unknown agent: 'nope'`,
    ]);
  });
});

describe('session machine concurrent agents', () => {
  it('runs multiple agents at the same time with isolated contexts and restarts one', async () => {
    const seen: string[] = [];
    const resolvers = new Map<string, () => void>();
    const requester: LlmRequester = {
      generate: (_config, { messages }, { onEvent }) => {
        const last = messages.at(-1);
        const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
        seen.push(text);
        return new Promise<void>((resolve) => {
          resolvers.set(text, () => {
            onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: `echo:${text}` } });
            onEvent?.({ type: 'llm.done' });
            resolve();
          });
        });
      },
    };
    const session = createTestSession();
    const env = await testEnv();
    const storeA = await env.open('a');
    const storeB = await env.open('b');
    sendCreate(session, requester, storeA, 'a');
    sendCreate(session, requester, storeB, 'b');

    submit(session, 'a', 'hello-a');
    submit(session, 'b', 'hello-b');

    await vi.waitFor(() => {
      expect(seen.toSorted()).toEqual(['hello-a', 'hello-b']);
    });
    expect(agentRef(session, 'a').getSnapshot().value).toEqual({ running: 'active' });
    expect(agentRef(session, 'b').getSnapshot().value).toEqual({ running: 'active' });

    resolvers.get('hello-a')?.();
    resolvers.get('hello-b')?.();
    await Promise.all([
      waitIdle(agentRef(session, 'a'), storeA, 2),
      waitIdle(agentRef(session, 'b'), storeB, 2),
    ]);

    expect(rolesAndTexts(storeA.getState().history)).toEqual([
      'user:hello-a',
      'assistant:echo:hello-a',
    ]);
    expect(rolesAndTexts(storeB.getState().history)).toEqual([
      'user:hello-b',
      'assistant:echo:hello-b',
    ]);

    const restarted: Array<{ agentId: string; ref: AgentActorRef }> = [];
    session.on('agent.restarted', (event) =>
      restarted.push({ agentId: event.agentId, ref: event.ref }),
    );
    const errors: string[] = [];
    session.on('agent.failed', (event) => errors.push(event.error));
    const oldRef = agentRef(session, 'a');

    session.send({ type: 'agent.restart', agentId: 'a' });
    expect(session.getSnapshot().context.agents['a']?.pendingRestart).toBe(true);
    session.send({ type: 'agent.restart', agentId: 'a' });
    expect(errors).toEqual([`agent 'a' restart already pending`]);

    await waitFor(session, (snapshot) => snapshot.context.agents['a']?.ref !== oldRef, {
      timeout: 5000,
    });

    expect(oldRef.getSnapshot().status).toBe('done');
    expect(Object.keys(session.getSnapshot().context.agents).toSorted()).toEqual(['a', 'b']);
    expect(restarted).toHaveLength(1);
    expect(restarted[0]?.agentId).toBe('a');
    expect(restarted[0]?.ref).toBe(agentRef(session, 'a'));

    submit(session, 'a', 'again');
    await vi.waitFor(() => {
      expect(seen).toContain('again');
    });
    resolvers.get('again')?.();
    await waitIdle(agentRef(session, 'a'), storeA, 4);

    expect(rolesAndTexts(storeA.getState().history)).toEqual([
      'user:hello-a',
      'assistant:echo:hello-a',
      'user:again',
      'assistant:echo:again',
    ]);
    expect(rolesAndTexts(storeB.getState().history)).toEqual([
      'user:hello-b',
      'assistant:echo:hello-b',
    ]);
  });
});

describe('session machine agent fork', () => {
  it('forks a agent with the source context and diverges afterwards', async () => {
    const session = createTestSession();
    const seenModels: LlmModel[] = [];
    const requester: LlmRequester = {
      generate: (config, { messages }, { onEvent }) => {
        seenModels.push(config.model);
        const last = messages.at(-1);
        const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
        onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: `echo:${text}` } });
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      },
    };
    const env = await testEnv();
    const storeA = await env.open('a');
    const sourceModel: LlmModel = { provider: 'test', model: 'source-model', capability: UNKNOWN_CAPABILITY };
    session.send({
      type: 'agent.create',
      agentId: 'a',
      logic: agentLogic(),
      input: {
        request: { model: sourceModel },
        store: storeA,
        scopeFactory: testScopeFactory({ store: storeA, requester }),
      },
    });
    submit(session, 'a', 'hi');
    await waitIdle(agentRef(session, 'a'), storeA, 2);
    expect(storeA.getState().turnIndex.nextTurnId).toBe(1);
    await storeA.flush();

    const forked: Array<{ agentId: string; branchId: string }> = [];
    session.on('agent.forked', (event) =>
      forked.push({ agentId: event.agentId, branchId: event.branchId }),
    );
    const storeB = await forkStore(env, storeA, 'b');
    session.send({
      type: 'agent.fork',
      sourceId: 'a',
      agentId: 'b',
      logic: agentLogic(),
      input: {
        store: storeB,
        scopeFactory: testScopeFactory({ store: storeB, requester }),
      } as unknown as AgentInput,
    });
    expect(forked).toEqual([{ agentId: 'b', branchId: 'b' }]);

    const refB = agentRef(session, 'b');
    await waitIdle(refB, storeB, 2);
    expect(refB.getSnapshot().value).toEqual({ idle: 'ready' });
    expect(storeB.getState().turnIndex.nextTurnId).toBe(1);
    expect(rolesAndTexts(storeB.getState().history)).toEqual([
      'user:hi',
      'assistant:echo:hi',
    ]);

    submit(session, 'b', 'fork-hi');
    await waitIdle(refB, storeB, 4);

    expect(storeB.getState().turnIndex.nextTurnId).toBe(2);
    expect(rolesAndTexts(storeB.getState().history)).toEqual([
      'user:hi',
      'assistant:echo:hi',
      'user:fork-hi',
      'assistant:echo:fork-hi',
    ]);
    expect(storeA.getState().history).toHaveLength(2);
    expect(storeA.getState().turnIndex.nextTurnId).toBe(1);
    expect(seenModels).toEqual([sourceModel, sourceModel]);
  });

  it('emits agent.failed when forking an unknown source or a duplicate id', async () => {
    const session = createTestSession();
    const requester = createEchoRequester();
    const errors: string[] = [];
    session.on('agent.failed', (event) => errors.push(event.error));
    const env = await testEnv();

    const storeB = await env.open('b');
    session.send({
      type: 'agent.fork',
      sourceId: 'nope',
      agentId: 'b',
      logic: agentLogic(),
      input: {
        request: { model },
        store: storeB,
        scopeFactory: testScopeFactory({ store: storeB, requester }),
      },
    });
    sendCreate(session, requester, await env.open('a'), 'a');
    const storeADup = await env.open('a-dup');
    session.send({
      type: 'agent.fork',
      sourceId: 'a',
      agentId: 'a',
      logic: agentLogic(),
      input: {
        request: { model },
        store: storeADup,
        scopeFactory: testScopeFactory({ store: storeADup, requester }),
      },
    });

    expect(errors).toEqual([`unknown agent: 'nope'`, `duplicate agent id: 'a'`]);
    expect(session.getSnapshot().context.agents['b']).toBeUndefined();
    expect(agentRef(session, 'a')).toBeDefined();
  });
});
