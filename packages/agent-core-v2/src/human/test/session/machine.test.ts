import { describe, expect, it, vi } from 'vitest';
import { createActor, waitFor, type ActorRefFrom } from '#/xstate2';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
} from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { createLlmMachine } from '#/llm/requester/machine';
import type { LlmRequester } from '#/llm/requester/requester';
import { emptyUsage } from '#/llm/usage';
import { createAgentMachine } from '#/agent/machine';
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

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

type SessionActor = ActorRefFrom<ReturnType<typeof createSessionMachine>>;

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

async function waitIdle(ref: AgentActorRef, messageCount: number) {
  return waitFor(
    ref,
    (snapshot) => snapshot.matches('idle') && snapshot.context.messages.length === messageCount,
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

    session.send({ type: 'agent.create' });
    session.send({ type: 'agent.create' });

    expect(created).toEqual(['agent-1', 'agent-2']);
    expect(Object.keys(session.getSnapshot().context.agents).toSorted()).toEqual(['agent-1', 'agent-2']);
  });

  it('creates a agent with restored messages and turnId', async () => {
    const session = createTestSession(createEchoRequester());
    const history: HistoryMessage[] = [
      createUserEntry(createUserMessage('old'), { source: 'input' }),
      createAssistantEntry(createAssistantMessage([{ type: 'text', text: 'echo:old' }]), {
        source: 'llm',
        usage: emptyUsage(),
      }),
    ];
    session.send({ type: 'agent.create', agentId: 'restored', input: { history, turnId: 7 } });

    const ref = agentRef(session, 'restored');
    expect(ref.getSnapshot().context.turnId).toBe(7);
    submit(session, 'restored', 'new');
    const snapshot = await waitIdle(ref, 4);

    expect(snapshot.context.turnId).toBe(8);
    expect(rolesAndTexts(snapshot.context.messages)).toEqual([
      'user:old',
      'assistant:echo:old',
      'user:new',
      'assistant:echo:new',
    ]);
  });

  it('rejects a duplicate agent id and keeps the existing agent', async () => {
    const session = createTestSession(createEchoRequester());
    const errors: string[] = [];
    session.on('agent.error', (event) => errors.push(event.error));

    session.send({ type: 'agent.create', agentId: 'a' });
    const first = agentRef(session, 'a');
    session.send({ type: 'agent.create', agentId: 'a' });

    expect(errors).toEqual([`duplicate agent id: 'a'`]);
    expect(agentRef(session, 'a')).toBe(first);
  });

  it('stops a agent and removes it from the registry', async () => {
    const session = createTestSession(createEchoRequester());
    session.send({ type: 'agent.create', agentId: 'a' });
    const ref = agentRef(session, 'a');
    const stopped: string[] = [];
    session.on('agent.stopped', (event) => stopped.push(event.agentId));

    session.send({ type: 'agent.stop', agentId: 'a' });

    expect(stopped).toEqual(['a']);
    expect(session.getSnapshot().context.agents['a']).toBeUndefined();
    expect(ref.getSnapshot().status).toBe('stopped');
  });

  it('emits agent.error when routing to an unknown agent', async () => {
    const session = createTestSession(createEchoRequester());
    const errors: string[] = [];
    session.on('agent.error', (event) => errors.push(event.error));

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
            onEvent?.({ type: 'llm.delta', part: { type: 'text', text: `echo:${text}` } });
            onEvent?.({ type: 'llm.done' });
            resolve();
          });
        });
      },
    };
    const session = createTestSession(requester);
    session.send({ type: 'agent.create', agentId: 'a' });
    session.send({ type: 'agent.create', agentId: 'b' });

    submit(session, 'a', 'hello-a');
    submit(session, 'b', 'hello-b');

    await vi.waitFor(() => {
      expect(seen.toSorted()).toEqual(['hello-a', 'hello-b']);
    });
    expect(agentRef(session, 'a').getSnapshot().value).toEqual({ running: 'active' });
    expect(agentRef(session, 'b').getSnapshot().value).toEqual({ running: 'active' });

    resolvers.get('hello-a')?.();
    resolvers.get('hello-b')?.();
    const [snapshotA, snapshotB] = await Promise.all([
      waitIdle(agentRef(session, 'a'), 2),
      waitIdle(agentRef(session, 'b'), 2),
    ]);

    expect(rolesAndTexts(snapshotA.context.messages)).toEqual([
      'user:hello-a',
      'assistant:echo:hello-a',
    ]);
    expect(rolesAndTexts(snapshotB.context.messages)).toEqual([
      'user:hello-b',
      'assistant:echo:hello-b',
    ]);
  });
});

describe('session machine agent fork', () => {
  it('forks a agent with the source context and diverges afterwards', async () => {
    const session = createTestSession(createEchoRequester());
    session.send({ type: 'agent.create', agentId: 'a' });
    submit(session, 'a', 'hi');
    const snapshotA = await waitIdle(agentRef(session, 'a'), 2);
    expect(snapshotA.context.turnId).toBe(1);

    const forked: string[] = [];
    session.on('agent.forked', (event) => forked.push(event.agentId));
    session.send({ type: 'agent.fork', sourceId: 'a', agentId: 'b' });
    expect(forked).toEqual(['b']);

    const refB = agentRef(session, 'b');
    const forkSnapshot = refB.getSnapshot();
    expect(forkSnapshot.value).toEqual({ idle: 'ready' });
    expect(forkSnapshot.context.turnId).toBe(1);
    expect(rolesAndTexts(forkSnapshot.context.messages)).toEqual([
      'user:hi',
      'assistant:echo:hi',
    ]);

    submit(session, 'b', 'fork-hi');
    const snapshotB = await waitIdle(refB, 4);

    expect(snapshotB.context.turnId).toBe(2);
    expect(rolesAndTexts(snapshotB.context.messages)).toEqual([
      'user:hi',
      'assistant:echo:hi',
      'user:fork-hi',
      'assistant:echo:fork-hi',
    ]);
    expect(agentRef(session, 'a').getSnapshot().context.messages).toHaveLength(2);
    expect(agentRef(session, 'a').getSnapshot().context.turnId).toBe(1);
  });

  it('emits agent.error when forking an unknown source', async () => {
    const session = createTestSession(createEchoRequester());
    const errors: string[] = [];
    session.on('agent.error', (event) => errors.push(event.error));

    session.send({ type: 'agent.fork', sourceId: 'nope', agentId: 'b' });

    expect(errors).toEqual([`unknown agent: 'nope'`]);
    expect(session.getSnapshot().context.agents['b']).toBeUndefined();
  });
});


describe('session machine agent switch', () => {
  it('switches an idle agent to a new branch context and emits agent.switched', async () => {
    const session = createTestSession(createEchoRequester());
    session.send({ type: 'agent.create', agentId: 'main' });
    submit(session, 'main', 'hi');
    await waitIdle(agentRef(session, 'main'), 2);

    const switched: Array<{ agentId: string; branchId: string; reason?: string }> = [];
    session.on('agent.switched', (event) => {
      if (event.type === 'agent.switched') {
        switched.push({ agentId: event.agentId, branchId: event.branchId, reason: event.reason });
      }
    });

    session.send({
      type: 'agent.switch',
      agentId: 'main',
      input: { branchId: 'main~2', history: [], turnId: 0, reason: 'undo' },
    });

    expect(switched).toEqual([{ agentId: 'main', branchId: 'main~2', reason: 'undo' }]);
    const snapshot = agentRef(session, 'main').getSnapshot();
    expect(snapshot.context.branchId).toBe('main~2');
    expect(snapshot.context.messages).toEqual([]);
    expect(snapshot.context.turnId).toBe(0);
  });

  it('emits agent.error when switching an unknown or busy agent', async () => {
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
    const errors: string[] = [];
    session.on('agent.error', (event) => errors.push(event.error));
    session.send({ type: 'agent.create', agentId: 'main' });

    session.send({
      type: 'agent.switch',
      agentId: 'nope',
      input: { branchId: 'x', history: [], turnId: 0 },
    });

    submit(session, 'main', 'hi');
    await vi.waitFor(() => expect(release).toBeDefined());
    session.send({
      type: 'agent.switch',
      agentId: 'main',
      input: { branchId: 'main~2', history: [], turnId: 0 },
    });

    expect(errors).toEqual([`unknown agent: 'nope'`, `agent is busy: 'main'`]);
    expect(agentRef(session, 'main').getSnapshot().context.branchId).toBe('main');
    release?.();
  });
});
