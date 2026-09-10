import { describe, expect, it } from 'vitest';
import { createActor, waitFor, type ActorRefFrom } from '#/xstate2';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createUserMessage, extractText } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import type { LlmRequester } from '#/llm/requester/requester';
import { createAgentMachine } from '#/agent/machine';
import { inputSubmitted, messageAppended, turnEnded, turnStarted } from '#/agent/events';
import { createTurnMachine, createUserEntry } from '#/agent/turn';
import type { AgentEventStore } from '#/agent/slices';
import { SessionStores } from '#/session/stores';
import { MemoryBackend } from '#/store/backend/memory';
import { TreeStore } from '#/store/store';
import type { Tree } from '#/store/tree';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

type AgentActor = ActorRefFrom<ReturnType<typeof createAgentMachine>>;

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

interface TestEnv {
  backend: MemoryBackend;
  tree: Tree;
  stores: SessionStores;
}

async function testEnv(): Promise<TestEnv> {
  const backend = new MemoryBackend();
  const store = await TreeStore.open(backend, {});
  const tree = await store.tree('sess');
  return { backend, tree, stores: new SessionStores(tree, backend) };
}

async function reopen(env: TestEnv): Promise<TestEnv> {
  await env.stores.flush();
  await env.stores.dispose();
  const store = await TreeStore.open(env.backend, {});
  const tree = await store.tree('sess');
  return { backend: env.backend, tree, stores: new SessionStores(tree, env.backend) };
}

function startAgent(store: AgentEventStore, requester: LlmRequester = createEchoRequester()): AgentActor {
  const actor = createActor(
    createAgentMachine({
      tools: [],
      turnActor: createTurnMachine(requester),
    }),
    { input: { request: { model }, store } },
  );
  actor.start();
  return actor;
}

async function runTurn(actor: AgentActor, store: AgentEventStore, text: string, historyLength: number): Promise<void> {
  actor.send({ type: 'input.submit', message: createUserMessage(text) });
  await waitFor(actor, (s) => s.matches('idle') && store.getState().history.length === historyLength, {
    timeout: 5000,
  });
}

function historyTexts(store: AgentEventStore): string[] {
  return store.getState().history.map((entry) => extractText(entry.message));
}

describe('SessionStores open/fork', () => {
  it('folds history and turnIndex for opened and forked agents, then diverges', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const actor = startAgent(main);
    await runTurn(actor, main, 'hi', 2);
    await env.stores.flush();

    const fork = await env.stores.fork('main', 'fork');
    expect(fork.ref.branch).toBe('fork');
    expect(historyTexts(fork)).toEqual(['hi', 'echo:hi']);
    expect(fork.getState().turnIndex.nextTurnId).toBe(1);
    const forkHeader = env.tree.openBranch('fork').header;
    expect(forkHeader.parentBranch).toBe('main');
    expect(forkHeader.parentSeq).toBe(env.tree.openBranch('main').head);

    expect((await env.stores.session()).getState().roster.agents).toEqual({
      fork: 'fork',
      main: 'main',
    });

    const forkActor = startAgent(fork);
    await runTurn(forkActor, fork, 'fork-hi', 4);
    await runTurn(actor, main, 'main-hi', 4);

    expect(historyTexts(fork)).toEqual(['hi', 'echo:hi', 'fork-hi', 'echo:fork-hi']);
    expect(historyTexts(main)).toEqual(['hi', 'echo:hi', 'main-hi', 'echo:main-hi']);
    expect(fork.getState().turnIndex.nextTurnId).toBe(2);
    expect(main.getState().turnIndex.nextTurnId).toBe(2);

    forkActor.stop();
    actor.stop();
  });

  it('removes the agent from the roster on close', async () => {
    const env = await testEnv();
    await env.stores.open('main');
    await env.stores.open('temp');
    expect((await env.stores.session()).getState().roster.agents).toEqual({
      main: 'main',
      temp: 'temp',
    });

    await env.stores.close('temp');

    expect(env.stores.get('temp')).toBeUndefined();
    expect((await env.stores.session()).getState().roster.agents).toEqual({ main: 'main' });
  });
});

describe('SessionStores undo', () => {
  it('rolls back to the turn boundary, forks with a parent ref, and updates the roster', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const actor = startAgent(main);
    await runTurn(actor, main, 'first', 2);
    await runTurn(actor, main, 'second', 4);
    await env.stores.flush();
    const cutStart = main.getState().turnIndex.turns.at(-1)?.start;
    expect(cutStart).toBeDefined();

    const result = await env.stores.undo('main', 1);

    expect(result.branchId).toBe('main~2');
    expect(main.ref.branch).toBe('main~2');
    expect(historyTexts(main)).toEqual(['first', 'echo:first', 'second']);
    expect(main.getState().queue).toEqual([]);
    expect(main.getState().turnIndex.turns).toHaveLength(1);
    expect(main.getState().turnIndex.nextTurnId).toBe(1);
    const header = env.tree.openBranch('main~2').header;
    expect(header.parentBranch).toBe('main');
    expect(header.parentSeq).toBe((cutStart as { seq: number }).seq - 1);
    expect((await env.stores.session()).getState().roster.agents['main']).toBe('main~2');
    expect(env.tree.openBranch('main').head).toBe(11);

    await waitFor(actor, (s) => s.matches('idle'), { timeout: 5000 });
    await runTurn(actor, main, 'third', 5);
    expect(historyTexts(main)).toEqual(['first', 'echo:first', 'second', 'third', 'echo:third']);
    expect(env.tree.openBranch('main').head).toBe(11);
    expect(main.getState().turnIndex.nextTurnId).toBe(2);

    actor.stop();
  });

  it('rejects invalid counts, unknown agents, and insufficient turns', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const actor = startAgent(main);
    await runTurn(actor, main, 'hi', 2);

    await expect(env.stores.undo('main', 2)).rejects.toMatchObject({ reason: 'insufficient' });
    await expect(env.stores.undo('nope', 1)).rejects.toMatchObject({ reason: 'unknown-agent' });
    await expect(env.stores.undo('main', 0)).rejects.toMatchObject({ reason: 'invalid-count' });

    actor.stop();
  });
});

describe('SessionStores reopen', () => {
  it('restores agent state from the branch after reopen', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const actor = startAgent(main);
    await runTurn(actor, main, 'first', 2);
    await runTurn(actor, main, 'second', 4);
    await env.stores.flush();
    const fork = await env.stores.fork('main', 'fork');
    const forkActor = startAgent(fork);
    await runTurn(forkActor, fork, 'fork-hi', 6);
    forkActor.stop();
    actor.stop();

    const restored = await reopen(env);

    expect((await restored.stores.session()).getState().roster.agents).toEqual({
      fork: 'fork',
      main: 'main',
    });
    const restoredMain = await restored.stores.open('main');
    expect(historyTexts(restoredMain)).toEqual(['first', 'echo:first', 'second', 'echo:second']);
    expect(restoredMain.getState().turnIndex.nextTurnId).toBe(2);
    const restoredFork = await restored.stores.open('fork');
    expect(historyTexts(restoredFork)).toEqual([
      'first',
      'echo:first',
      'second',
      'echo:second',
      'fork-hi',
      'echo:fork-hi',
    ]);
    expect(restoredFork.getState().turnIndex.nextTurnId).toBe(3);

    const actor2 = startAgent(restoredMain);
    await runTurn(actor2, restoredMain, 'again', 6);
    expect(historyTexts(restoredMain)).toEqual([
      'first',
      'echo:first',
      'second',
      'echo:second',
      'again',
      'echo:again',
    ]);
    expect(restoredMain.getState().turnIndex.nextTurnId).toBe(3);

    actor2.stop();
  });
});

describe('SessionStores switchBranch', () => {
  it('seeds a fresh branch, resets the store, and blocks undo across the switch', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const actor = startAgent(main);
    await runTurn(actor, main, 'first', 2);
    actor.stop();
    const switched: { branch: string; reason?: string; stats?: Record<string, number> }[] = [];
    (await env.stores.session()).subscribe((_state, cause) => {
      if (cause.kind === 'event' && cause.event.type === 'agent.switched') {
        const event = cause.event as { branch: string; reason?: string; stats?: Record<string, number> };
        switched.push({ branch: event.branch, reason: event.reason, stats: event.stats });
      }
    });

    const result = await env.stores.switchBranch('main', {
      reason: 'compaction',
      stats: { compactedCount: 2, tokensBefore: 10, tokensAfter: 5 },
      seed: [
        turnStarted({ turnId: 1 }),
        messageAppended({ message: createUserEntry(createUserMessage('seed-user')) }),
        messageAppended({ message: createUserEntry(createUserMessage('seed-summary')) }),
        turnEnded({ turnId: 1, outcome: 'done' }),
        inputSubmitted({ message: createUserMessage('queued') }),
      ],
    });

    expect(result.branchId).toBe('main~2');
    expect(main.ref.branch).toBe('main~2');
    expect(historyTexts(main)).toEqual(['seed-user', 'seed-summary']);
    expect(main.getState().turnIndex).toEqual({
      turns: [{ turnId: 1, start: { branch: 'main~2', seq: 0 }, end: { branch: 'main~2', seq: 3 } }],
      nextTurnId: 2,
    });
    expect(main.getState().queue).toEqual([{ id: undefined, message: createUserMessage('queued') }]);
    expect(env.tree.openBranch('main~2').header.parentBranch).toBeUndefined();
    expect(switched).toEqual([
      {
        branch: 'main~2',
        reason: 'compaction',
        stats: { compactedCount: 2, tokensBefore: 10, tokensAfter: 5 },
      },
    ]);
    await expect(env.stores.undo('main', 1)).rejects.toMatchObject({ reason: 'insufficient' });

    const actor2 = startAgent(main);
    await waitFor(actor2, (s) => s.matches('idle') && main.getState().history.length === 4, {
      timeout: 5000,
    });
    expect(historyTexts(main)).toEqual(['seed-user', 'seed-summary', 'queued', 'echo:queued']);
    expect(main.getState().turnIndex.nextTurnId).toBe(3);

    actor2.stop();
  });
});
