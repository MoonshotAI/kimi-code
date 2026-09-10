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
import { createAgentMachine } from '#/agent/machine';
import { messageAppended, turnEnded } from '#/agent/events';
import { agentSlices, type AgentEventStore } from '#/agent/slices';
import {
  createAssistantEntry,
  createTurnMachine,
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

function createTestSession(requester: LlmRequester): SessionActor {
  const session = createActor(
    createSessionMachine({
      agent: createAgentMachine({
        tools: [],
        turnActor: createTurnMachine(requester),
      }),
    }),
    { input: { request: { model } } },
  );
  session.start();
  return session;
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
    event: { type: 'input.submit', message: createUserMessage(text) },
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
    const session = createTestSession(createEchoRequester());
    const created: string[] = [];
    session.on('agent.created', (event) => created.push(event.agentId));
    const env = await testEnv();

    session.send({ type: 'agent.create', input: { store: await env.open('agent-1') } });
    session.send({ type: 'agent.create', input: { store: await env.open('agent-2') } });

    expect(created).toEqual(['agent-1', 'agent-2']);
    expect(Object.keys(session.getSnapshot().context.agents).toSorted()).toEqual(['agent-1', 'agent-2']);
  });

  it('creates a agent with restored messages and turnId', async () => {
    const session = createTestSession(createEchoRequester());
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
    session.send({ type: 'agent.create', agentId: 'restored', input: { store } });

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
    const session = createTestSession(createEchoRequester());
    const errors: string[] = [];
    session.on('agent.failed', (event) => errors.push(event.error));
    const env = await testEnv();

    session.send({ type: 'agent.create', agentId: 'a', input: { store: await env.open('a') } });
    const first = agentRef(session, 'a');
    session.send({ type: 'agent.create', agentId: 'a', input: { store: await env.open('a-dup') } });

    expect(errors).toEqual([`duplicate agent id: 'a'`]);
    expect(agentRef(session, 'a')).toBe(first);
  });

  it('stops a agent and removes it from the registry', async () => {
    const session = createTestSession(createEchoRequester());
    const env = await testEnv();
    session.send({ type: 'agent.create', agentId: 'a', input: { store: await env.open('a') } });
    const ref = agentRef(session, 'a');
    const stopped: string[] = [];
    session.on('agent.stopped', (event) => stopped.push(event.agentId));

    session.send({ type: 'agent.stop', agentId: 'a' });

    expect(stopped).toEqual(['a']);
    expect(session.getSnapshot().context.agents['a']).toBeUndefined();
    expect(ref.getSnapshot().status).toBe('stopped');
  });

  it('emits agent.failed when routing to an unknown agent', async () => {
    const session = createTestSession(createEchoRequester());
    const errors: string[] = [];
    session.on('agent.failed', (event) => errors.push(event.error));

    submit(session, 'nope', 'hi');
    session.send({ type: 'agent.stop', agentId: 'nope' });

    expect(errors).toEqual([`unknown agent: 'nope'`, `unknown agent: 'nope'`]);
  });
});

describe('session machine concurrent agents', () => {
  it('runs multiple agents at the same time with isolated contexts', async () => {
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
    const session = createTestSession(requester);
    const env = await testEnv();
    const storeA = await env.open('a');
    const storeB = await env.open('b');
    session.send({ type: 'agent.create', agentId: 'a', input: { store: storeA } });
    session.send({ type: 'agent.create', agentId: 'b', input: { store: storeB } });

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
  });
});

describe('session machine agent fork', () => {
  it('forks a agent with the source context and diverges afterwards', async () => {
    const session = createTestSession(createEchoRequester());
    const env = await testEnv();
    const storeA = await env.open('a');
    session.send({ type: 'agent.create', agentId: 'a', input: { store: storeA } });
    submit(session, 'a', 'hi');
    await waitIdle(agentRef(session, 'a'), storeA, 2);
    expect(storeA.getState().turnIndex.nextTurnId).toBe(1);
    await storeA.flush();

    const forked: string[] = [];
    session.on('agent.forked', (event) => forked.push(event.agentId));
    const storeB = await forkStore(env, storeA, 'b');
    session.send({ type: 'agent.fork', sourceId: 'a', agentId: 'b', store: storeB });
    expect(forked).toEqual(['b']);

    const refB = agentRef(session, 'b');
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
  });

  it('emits agent.failed when forking an unknown source', async () => {
    const session = createTestSession(createEchoRequester());
    const errors: string[] = [];
    session.on('agent.failed', (event) => errors.push(event.error));
    const env = await testEnv();

    session.send({ type: 'agent.fork', sourceId: 'nope', agentId: 'b', store: await env.open('b') });

    expect(errors).toEqual([`unknown agent: 'nope'`]);
    expect(session.getSnapshot().context.agents['b']).toBeUndefined();
  });
});
