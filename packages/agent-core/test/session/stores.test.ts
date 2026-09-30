import { describe, expect, it } from 'vitest';
import { createUserEntry, createUserMessage, extractText } from '#/llm/message';
import { UNKNOWN_CAPABILITY, type LlmModel } from '#/llm/model';
import type { LlmRequester } from '#/llm/requester/requester';
import { openBlobs } from '#/store/blob';
import { treeJournal } from '#/store/journal';
import { MemoryBackend, Trees, type Tree } from '#/store/tree';
import type { AgentStore } from '#/stores/agent';
import { openSessionStores, SESSION_LOG_BRANCH, type AgentSwitched, type SessionStores } from '#/stores/session';
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

async function reopen(env: TestEnv, beforeReopen?: () => Promise<void>): Promise<TestEnv> {
  await env.stores.flush();
  await env.stores.dispose();
  await beforeReopen?.();
  const trees = await Trees.open(env.backend.trees, {});
  const tree = await trees.tree('sess');
  return { backend: env.backend, tree, stores: await openSessionStores(tree, openBlobs(env.backend.blobs)) };
}

function mountTestAgent(
  store: AgentStore,
  opts: { agentId: string; branchId?: string; requester?: LlmRequester },
): AgentHandle {
  const handle = mountAgent({
    sessionId: 'sess',
    agentId: opts.agentId,
    store,
    branchId: opts.branchId,
  });
  handle.setConfig({ model });
  handle.setRequester(opts.requester ?? createEchoRequester());
  return handle;
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
  const ids: { started?: number; done?: number } = {};
  const done = new Promise<void>((resolve) => {
    host.on('turn.started', (event) => { ids.started = event.turnId; });
    host.on('turn.done', (event) => { ids.done = event.turnId; resolve(); });
  });
  host.submit(createUserMessage(text));
  await done;
  expect(ids.done).toBe(ids.started);
  expect(store.getState().history.length).toBe(historyLength);
  expect(store.getState().history.some((entry) => entry.message.role === 'assistant')).toBe(true);
}

function historyTexts(store: AgentStore): string[] {
  return store.getState().history.map((entry) => extractText(entry.message));
}

describe('SessionStores open/fork', () => {
  it('folds history and turnIndex for opened and forked agents, then diverges', async () => {
    const env = await testEnv();
    const sessionJournal: string[] = [];
    env.stores.session.onCommit((entry) => {
      sessionJournal.push(entry.event.type);
    });
    const main = await env.stores.open('main', { source: 'test-source' });
    const journal: string[] = [];
    main.onCommit((entry) => {
      const type = entry.event.type as string;
      if (type === 'turn.started' || type === 'message.appended' || type === 'turn.ended') {
        journal.push(type);
      }
    });
    const actor = await startAgent(main, { agentId: 'main', branchId: env.stores.branch('main') });
    await runTurn(actor, main, 'hi', 2);
    expect(journal).toEqual(['turn.started', 'message.appended', 'message.appended', 'turn.ended']);
    await env.stores.flush();

    const fork = await env.stores.fork('main', 'fork');
    expect(env.stores.branch('fork')).toBe('fork');
    expect(sessionJournal).toEqual(['agent.created', 'agent.created']);
    expect(historyTexts(fork)).toEqual(['hi', 'echo:hi']);
    expect(fork.getState().turnIndex.nextTurnId).toBe(1);
    const forkHeader = env.tree.openBranch('fork').header;
    expect(forkHeader.parentBranch).toBe('main');
    expect(forkHeader.parentSeq).toBe(env.tree.openBranch('main').head);

    expect(env.stores.session.getState().roster.agents).toEqual({
      fork: { branch: 'fork' },
      main: { branch: 'main', source: 'test-source' },
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

  it('keeps the agent roster entry on close', async () => {
    const env = await testEnv();
    await env.stores.open('main');
    await env.stores.open('temp');
    expect(env.stores.session.getState().roster.agents).toEqual({
      main: { branch: 'main' },
      temp: { branch: 'temp' },
    });

    await env.stores.close('temp');

    expect(env.stores.get('temp')).toBeUndefined();
    expect(env.stores.session.getState().roster.agents).toEqual({
      main: { branch: 'main' },
      temp: { branch: 'temp' },
    });

    await env.stores.session.dispatch({ type: 'session.meta_updated', meta: { title: 'demo' } });
    await env.stores.session.dispatch({
      type: 'session.meta_updated',
      meta: { lastTurn: { turnId: 0, outcome: 'done' } },
    });
    expect(env.stores.session.getState().sessionMeta.value).toEqual({
      title: 'demo',
      lastTurn: { turnId: 0, outcome: 'done' },
    });
  });
});

describe('SessionStores undo', () => {
  it('rolls back to the turn boundary, forks with a parent ref, and updates the roster', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main', { source: 'test-source' });
    const actor = await startAgent(main, { agentId: 'main', branchId: env.stores.branch('main') });
    await runTurn(actor, main, 'first', 2);
    await runTurn(actor, main, 'second', 4);
    await env.stores.flush();
    const cutStart = main.getState().turnIndex.turns.at(-1)?.start;
    expect(cutStart).toBeDefined();

    const result = await env.stores.undo('main', 1);

    expect(result.branchId).toBe('main~2');
    expect(env.stores.branch('main')).toBe('main~2');
    expect(historyTexts(main)).toEqual(['first', 'echo:first']);
    expect(main.getState().turnIndex.turns).toHaveLength(1);
    expect(main.getState().turnIndex.nextTurnId).toBe(1);
    const header = env.tree.openBranch('main~2').header;
    expect(header.parentBranch).toBe('main');
    expect(header.parentSeq).toBe((cutStart as { seq: number }).seq - 1);
    expect(env.stores.session.getState().roster.agents['main']).toEqual({
      branch: 'main~2',
      source: 'test-source',
    });
    expect(env.tree.openBranch('main').head).toBe(8);

    await actor.disposeAsync();
    const resumed = await startAgent(main, { agentId: 'main', branchId: env.stores.branch('main') });
    await runTurn(resumed, main, 'third', 4);
    expect(historyTexts(main)).toEqual(['first', 'echo:first', 'third', 'echo:third']);
    expect(env.tree.openBranch('main').head).toBe(8);
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

    const restored = await reopen(env, async () => {
      await treeJournal(env.tree, env.tree.openBranch(SESSION_LOG_BRANCH)).append({
        type: 'agent.opened',
        agentId: 'old',
        branch: 'old',
      });
    });

    expect(restored.stores.session.getState().roster.agents).toEqual({
      fork: { branch: 'fork' },
      main: { branch: 'main~2' },
      old: { branch: 'old' },
    });
    const restoredMain = await restored.stores.open('main');
    expect(restored.stores.branch('main')).toBe('main~2');
    expect(historyTexts(restoredMain)).toEqual(['first', 'echo:first']);
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
    await runTurn(actor2, restoredMain, 'again', 4);
    expect(historyTexts(restoredMain)).toEqual([
      'first',
      'echo:first',
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
    const spec = main.getState().spec;
    expect(spec).toBeDefined();
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
      ],
    });

    expect(result.branchId).toBe('main~2');
    expect(env.stores.branch('main')).toBe('main~2');
    expect(historyTexts(main)).toEqual(['seed-user', 'seed-summary']);
    expect(main.getState().spec).toEqual(spec);
    expect(main.getState().turnIndex).toEqual({
      turns: [{ turnId: 1, start: { branch: 'main~2', seq: 0 }, end: { branch: 'main~2', seq: 3 } }],
      nextTurnId: 2,
    });
    expect(env.tree.openBranch('main~2').header.parentBranch).toBeUndefined();
    expect(switched).toEqual([
      {
        branch: 'main~2',
        reason: 'compaction',
        stats: { compactedCount: 2, tokensBefore: 10, tokensAfter: 5 },
      },
    ]);
    await expect(env.stores.undo('main', 1)).rejects.toMatchObject({ reason: 'insufficient' });

    const actor2 = await startAgent(main, { agentId: 'main', branchId: env.stores.branch('main') });
    await runTurn(actor2, main, 'again', 4);
    expect(historyTexts(main)).toEqual(['seed-user', 'seed-summary', 'again', 'echo:again']);
    expect(main.getState().turnIndex.nextTurnId).toBe(3);

    await actor2.disposeAsync();
  });
});

describe('agent store context.reset', () => {
  it('replaces history wholesale and preserves both turnIndex cursor forms', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const summaryA = createUserEntry(createUserMessage('summary-a'), { source: 'compaction', key: 'summary' });
    const summaryB = createUserEntry(createUserMessage('summary-b'), { source: 'compaction', key: 'summary' });

    await main.dispatch([
      { type: 'turn.started', turnId: 0 },
      { type: 'message.appended', message: createUserEntry(createUserMessage('old')) },
      { type: 'turn.ended', turnId: 0, outcome: 'done' },
      { type: 'context.reset', messages: [summaryA], reason: 'manual' },
    ]);

    expect(historyTexts(main)).toEqual(['summary-a']);
    expect(main.getState().turnIndex.nextTurnId).toBe(1);
    expect(main.getState().turnIndex.turns).toHaveLength(1);
    expect(main.getState().turnIndex.turns[0]?.end).toBeDefined();

    await main.dispatch([
      { type: 'turn.started', turnId: 1 },
      { type: 'message.appended', message: createUserEntry(createUserMessage('in-flight')) },
      { type: 'context.reset', messages: [summaryB], reason: 'budget' },
    ]);

    expect(historyTexts(main)).toEqual(['summary-b']);
    expect(main.getState().turnIndex.nextTurnId).toBe(1);
    expect(main.getState().turnIndex.turns[1]?.end).toBeUndefined();

    await main.dispatch([
      { type: 'message.appended', message: createUserEntry(createUserMessage('after')) },
      { type: 'turn.ended', turnId: 1, outcome: 'done' },
    ]);

    expect(historyTexts(main)).toEqual(['summary-b', 'after']);
    expect(main.getState().turnIndex.nextTurnId).toBe(2);
    expect(main.getState().turnIndex.turns[1]?.end).toBeDefined();

    await env.stores.dispose();
  });
});

describe('turn compacting', () => {
  const summarySeed = (): ReturnType<typeof createUserEntry>[] => [
    createUserEntry(createUserMessage('seed-summary'), { source: 'compaction', key: 'summary' }),
  ];

  function createOverflowThenEchoRequester(calls: { messages: string[] }[]): LlmRequester {
    let attempt = 0;
    return {
      generate: (_config, { messages }, { onEvent }) => {
        attempt += 1;
        calls.push({
          messages: messages.map((message) => extractText(message)),
        });
        if (attempt === 1) {
          onEvent?.({
            type: 'llm.failed.remote',
            error: {
              kind: 'context_overflow',
              message: 'maximum context length exceeded',
              statusCode: 400,
              requestId: null,
              retryAfterMs: null,
              headers: null,
            },
          });
          return Promise.resolve();
        }
        const last = messages.at(-1);
        const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
        onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: `echo:${text}` } });
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      },
    };
  }

  it('continues in place after a budget decision and keeps journal and memory consistent', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const journal: string[] = [];
    main.onCommit((entry) => {
      const type = entry.event.type as string;
      if (type === 'turn.started' || type === 'message.appended' || type === 'turn.ended' || type === 'context.reset') {
        journal.push(type);
      }
    });
    let beforeStepCalls = 0;
    const calls: { messages: string[] }[] = [];
    const actor = mountAgent({
      sessionId: 'sess',
      agentId: 'main',
      store: main,
      branchId: env.stores.branch('main'),
      turnOptions: {
        onBeforeStep: () => {
          beforeStepCalls += 1;
          return beforeStepCalls === 1 ? { compact: true as const } : undefined;
        },
      },
    });
    actor.setConfig({ model });
    actor.setRequester(createEchoRequester());
    actor.on('turn.compaction_requested', (event) => {
      expect(event.reason).toBe('budget');
      expect(event.turnId).toBe(0);
      actor.contextReset({ messages: summarySeed(), reason: 'budget' });
    });
    await actor.ready();
    const done = new Promise<'done' | 'failed' | 'aborted'>((resolve) => {
      actor.on('turn.done', (event) => { resolve(event.outcome.type); });
    });
    actor.submit(createUserMessage('hi'));

    expect(await done).toBe('done');
    expect(beforeStepCalls).toBe(2);
    expect(historyTexts(main)).toEqual(['seed-summary', 'echo:seed-summary']);
    expect(journal).toEqual([
      'turn.started',
      'message.appended',
      'context.reset',
      'message.appended',
      'turn.ended',
    ]);
    const snapshot = actor.snapshot.value;
    expect(snapshot?.context.messages.map((entry) => extractText(entry.message))).toEqual(
      historyTexts(main),
    );

    await actor.disposeAsync();
  });

  it('continues in place after a context_overflow failure and resends the request on the seed', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    const calls: { messages: string[] }[] = [];
    const actor = mountAgent({
      sessionId: 'sess',
      agentId: 'main',
      store: main,
      branchId: env.stores.branch('main'),
    });
    actor.setConfig({ model });
    actor.setRequester(createOverflowThenEchoRequester(calls));
    actor.on('turn.compaction_requested', (event) => {
      expect(event.reason).toBe('overflow');
      actor.contextReset({ messages: summarySeed(), reason: 'overflow' });
    });
    await actor.ready();
    const done = new Promise<'done' | 'failed' | 'aborted'>((resolve) => {
      actor.on('turn.done', (event) => { resolve(event.outcome.type); });
    });
    actor.submit(createUserMessage('hi'));

    expect(await done).toBe('done');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.messages).toEqual(['hi']);
    expect(calls[1]?.messages).toEqual(['seed-summary']);
    expect(historyTexts(main)).toEqual(['seed-summary', 'echo:seed-summary']);

    await actor.disposeAsync();
  });

  it('fails the turn when the reset response carries an error and aborts cleanly during compacting', async () => {
    const env = await testEnv();
    const main = await env.stores.open('main');
    let compactionCalls = 0;
    const actor = mountAgent({
      sessionId: 'sess',
      agentId: 'main',
      store: main,
      branchId: env.stores.branch('main'),
      turnOptions: {
        onBeforeStep: () => {
          compactionCalls += 1;
          return compactionCalls === 1 ? { compact: true as const } : undefined;
        },
      },
    });
    actor.setConfig({ model });
    actor.setRequester(createEchoRequester());
    actor.on('turn.compaction_requested', () => {
      actor.contextReset({ error: new Error('summary unavailable') });
    });
    await actor.ready();
    const outcomes: string[] = [];
    actor.on('turn.done', (event) => { outcomes.push(event.outcome.type); });
    actor.submit(createUserMessage('hi'));
    await new Promise<void>((resolve) => {
      actor.on('turn.done', () => { resolve(); });
    });

    expect(outcomes).toEqual(['failed']);
    expect(historyTexts(main)).toEqual(['hi']);

    await actor.disposeAsync();

    let aborted = false;
    const actor2 = mountAgent({
      sessionId: 'sess',
      agentId: 'main',
      store: main,
      branchId: env.stores.branch('main'),
      turnOptions: {
        onBeforeStep: () => (aborted ? undefined : { compact: true as const }),
      },
    });
    actor2.setConfig({ model });
    actor2.setRequester(createEchoRequester());
    actor2.on('turn.compaction_requested', () => {
      actor2.abort();
    });
    await actor2.ready();
    const abortedDone = new Promise<'done' | 'failed' | 'aborted'>((resolve) => {
      actor2.on('turn.done', (event) => { resolve(event.outcome.type); });
    });
    actor2.submit(createUserMessage('again'));

    expect(await abortedDone).toBe('aborted');
    aborted = true;

    await actor2.disposeAsync();
  });
});
