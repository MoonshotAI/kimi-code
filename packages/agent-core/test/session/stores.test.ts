import { describe, expect, it } from 'vitest';
import { createUserEntry, createUserMessage, extractText } from '#/llm/message';
import { UNKNOWN_CAPABILITY, type LlmModel } from '#/llm/model';
import type { LlmRequester } from '#/llm/requester/requester';
import { openBlobs } from '#/store/blob';
import { MemoryBackend, Trees, type Tree } from '#/store/tree';
import type { AgentStore } from '#/stores/agent';
import { openSessionStores, type AgentSwitched, type SessionStores } from '#/stores/session';
import { mountAgent, type AgentHandle } from '#/app/index';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

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
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return { backend, tree, stores: await openSessionStores(tree, openBlobs(backend.blobs)) };
}

async function reopen(env: TestEnv): Promise<TestEnv> {
  await env.stores.flush();
  await env.stores.dispose();
  const trees = await Trees.open(env.backend.trees, {});
  const tree = await trees.tree('sess');
  return { backend: env.backend, tree, stores: await openSessionStores(tree, openBlobs(env.backend.blobs)) };
}

function mountTestAgent(
  store: AgentStore,
  opts: { agentId: string; branchId?: string; requester?: LlmRequester },
): AgentHandle {
  return mountAgent({
    sessionId: 'sess',
    agentId: opts.agentId,
    store,
    branchId: opts.branchId,
    request: { config: { model } },
    requester: opts.requester ?? createEchoRequester(),
  });
}

async function startAgent(
  store: AgentStore,
  opts: { agentId: string; branchId?: string; requester?: LlmRequester },
): Promise<AgentHandle> {
  const host = mountTestAgent(store, opts);
  await host.ready();
  return host;
}

async function runTurn(host: AgentHandle, store: AgentStore, text: string, historyLength: number): Promise<void> {
  const done = new Promise<void>((resolve) => {
    host.on('turn.done', () => { resolve(); });
  });
  host.submit(createUserMessage(text));
  await done;
  expect(store.getState().history.length).toBe(historyLength);
  expect(store.getState().history.some((entry) => entry.message.role === 'assistant')).toBe(true);
}

function historyTexts(store: AgentStore): string[] {
  return store.getState().history.map((entry) => extractText(entry.message));
}

describe('SessionStores open/fork', () => {
  it('folds history and turnIndex for opened and forked agents, then diverges', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const actor = await startAgent(main, { agentId: 'main', branchId: env.stores.branch('main') });
    await runTurn(actor, main, 'hi', 2);
    await env.stores.flush();

    const fork = await env.stores.fork('main', 'fork');
    expect(env.stores.branch('fork')).toBe('fork');
    expect(historyTexts(fork)).toEqual(['hi', 'echo:hi']);
    expect(fork.getState().turnIndex.nextTurnId).toBe(1);
    const forkHeader = env.tree.openBranch('fork').header;
    expect(forkHeader.parentBranch).toBe('main');
    expect(forkHeader.parentSeq).toBe(env.tree.openBranch('main').head);

    expect(env.stores.session.getState().roster.agents).toEqual({
      fork: 'fork',
      main: 'main',
    });

    const forkActor = await startAgent(fork, { agentId: 'fork', branchId: env.stores.branch('fork') });
    await runTurn(forkActor, fork, 'fork-hi', 4);
    await runTurn(actor, main, 'main-hi', 4);

    expect(historyTexts(fork)).toEqual(['hi', 'echo:hi', 'fork-hi', 'echo:fork-hi']);
    expect(historyTexts(main)).toEqual(['hi', 'echo:hi', 'main-hi', 'echo:main-hi']);
    expect(fork.getState().turnIndex.nextTurnId).toBe(2);
    expect(main.getState().turnIndex.nextTurnId).toBe(2);

    await forkActor.disposeAsync();
    await actor.disposeAsync();
  });

  it('removes the agent from the roster on close', async () => {
    const env = await testEnv();
    await env.stores.open('main');
    await env.stores.open('temp');
    expect(env.stores.session.getState().roster.agents).toEqual({
      main: 'main',
      temp: 'temp',
    });

    await env.stores.close('temp');

    expect(env.stores.get('temp')).toBeUndefined();
    expect(env.stores.session.getState().roster.agents).toEqual({ main: 'main' });
  });
});

describe('SessionStores undo', () => {
  it('rolls back to the turn boundary, forks with a parent ref, and updates the roster', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const actor = await startAgent(main, { agentId: 'main', branchId: env.stores.branch('main') });
    await runTurn(actor, main, 'first', 2);
    await runTurn(actor, main, 'second', 4);
    await env.stores.flush();
    const cutStart = main.getState().turnIndex.turns.at(-1)?.start;
    expect(cutStart).toBeDefined();

    const result = await env.stores.undo('main', 1);

    expect(result.branchId).toBe('main~2');
    expect(env.stores.branch('main')).toBe('main~2');
    expect(historyTexts(main)).toEqual(['first', 'echo:first', 'second']);
    expect(main.getState().queue).toEqual([]);
    expect(main.getState().turnIndex.turns).toHaveLength(1);
    expect(main.getState().turnIndex.nextTurnId).toBe(1);
    const header = env.tree.openBranch('main~2').header;
    expect(header.parentBranch).toBe('main');
    expect(header.parentSeq).toBe((cutStart as { seq: number }).seq - 1);
    expect(env.stores.session.getState().roster.agents['main']).toBe('main~2');
    expect(env.tree.openBranch('main').head).toBe(7);

    await actor.disposeAsync();
    const resumed = await startAgent(main, { agentId: 'main', branchId: env.stores.branch('main') });
    await runTurn(resumed, main, 'third', 5);
    expect(historyTexts(main)).toEqual(['first', 'echo:first', 'second', 'third', 'echo:third']);
    expect(env.tree.openBranch('main').head).toBe(7);
    expect(main.getState().turnIndex.nextTurnId).toBe(2);

    await resumed.disposeAsync();
  });

  it('rejects invalid counts, unknown agents, and insufficient turns', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const actor = await startAgent(main, { agentId: 'main', branchId: env.stores.branch('main') });
    await runTurn(actor, main, 'hi', 2);

    await expect(env.stores.undo('main', 2)).rejects.toMatchObject({ reason: 'insufficient' });
    await expect(env.stores.undo('nope', 1)).rejects.toMatchObject({ reason: 'unknown-agent' });
    await expect(env.stores.undo('main', 0)).rejects.toMatchObject({ reason: 'invalid-count' });

    await actor.disposeAsync();
  });
});

describe('SessionStores reopen', () => {
  it('restores agent state from the branch after reopen', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const actor = await startAgent(main, { agentId: 'main', branchId: env.stores.branch('main') });
    await runTurn(actor, main, 'first', 2);
    await runTurn(actor, main, 'second', 4);
    await env.stores.flush();
    const fork = await env.stores.fork('main', 'fork');
    const forkActor = await startAgent(fork, { agentId: 'fork', branchId: env.stores.branch('fork') });
    await runTurn(forkActor, fork, 'fork-hi', 6);
    await forkActor.disposeAsync();
    await actor.disposeAsync();
    await env.stores.undo('main', 1);

    const restored = await reopen(env);

    expect(restored.stores.session.getState().roster.agents).toEqual({
      fork: 'fork',
      main: 'main~2',
    });
    const restoredMain = await restored.stores.open('main');
    expect(restored.stores.branch('main')).toBe('main~2');
    expect(historyTexts(restoredMain)).toEqual(['first', 'echo:first', 'second']);
    expect(restoredMain.getState().turnIndex.nextTurnId).toBe(1);
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

    const actor2 = await startAgent(restoredMain, { agentId: 'main', branchId: restored.stores.branch('main') });
    await runTurn(actor2, restoredMain, 'again', 5);
    expect(historyTexts(restoredMain)).toEqual([
      'first',
      'echo:first',
      'second',
      'again',
      'echo:again',
    ]);
    expect(restoredMain.getState().turnIndex.nextTurnId).toBe(2);

    await actor2.disposeAsync();
  });
});

describe('SessionStores switchBranch', () => {
  it('seeds a fresh branch, resets the store, and blocks undo across the switch', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const actor = await startAgent(main, { agentId: 'main', branchId: env.stores.branch('main') });
    await runTurn(actor, main, 'first', 2);
    await actor.disposeAsync();
    const switched: { branch: string; reason?: string; stats?: Record<string, number> }[] = [];
    env.stores.session.onCommit((entry) => {
      if (entry.event.type === 'agent.switched') {
        const event = entry.event as unknown as AgentSwitched;
        switched.push({ branch: event.branch, reason: event.reason, stats: event.stats });
      }
    });

    const result = await env.stores.switchBranch('main', {
      reason: 'compaction',
      stats: { compactedCount: 2, tokensBefore: 10, tokensAfter: 5 },
      seed: [
        { type: 'turn.started', turnId: 1 },
        { type: 'message.appended', message: createUserEntry(createUserMessage('seed-user')) },
        { type: 'message.appended', message: createUserEntry(createUserMessage('seed-summary')) },
        { type: 'turn.ended', turnId: 1, outcome: 'done' },
        { type: 'input.submitted', entry: createUserEntry(createUserMessage('queued')) },
      ],
    });

    expect(result.branchId).toBe('main~2');
    expect(env.stores.branch('main')).toBe('main~2');
    expect(historyTexts(main)).toEqual(['seed-user', 'seed-summary']);
    expect(main.getState().turnIndex).toEqual({
      turns: [{ turnId: 1, start: { branch: 'main~2', seq: 0 }, end: { branch: 'main~2', seq: 3 } }],
      nextTurnId: 2,
    });
    expect(main.getState().queue).toEqual([
      { message: createUserMessage('queued'), meta: { source: 'input' } },
    ]);
    expect(env.tree.openBranch('main~2').header.parentBranch).toBeUndefined();
    expect(switched).toEqual([
      {
        branch: 'main~2',
        reason: 'compaction',
        stats: { compactedCount: 2, tokensBefore: 10, tokensAfter: 5 },
      },
    ]);
    await expect(env.stores.undo('main', 1)).rejects.toMatchObject({ reason: 'insufficient' });

    const actor2 = mountTestAgent(main, { agentId: 'main', branchId: env.stores.branch('main') });
    const queued = new Promise<void>((resolve) => { actor2.on('turn.done', () => { resolve(); }); });
    await actor2.ready();
    await queued;
    expect(historyTexts(main)).toEqual(['seed-user', 'seed-summary', 'queued', 'echo:queued']);
    expect(main.getState().turnIndex.nextTurnId).toBe(3);

    await actor2.disposeAsync();
  });
});
