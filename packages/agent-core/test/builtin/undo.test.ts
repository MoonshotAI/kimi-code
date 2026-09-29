import { describe, expect, it } from 'vitest';

import { createHarness, type AgentHandle, type AppHandle, type SessionHandle } from '#/app/index';
import {
  createTelemetry,
  useTelemetryAppender,
  type TelemetryAppender,
  type TelemetryAppenderRecord,
} from '#/builtin/telemetry/index';
import {
  UndoRef,
  computeUndoAvailability,
  isCompactionSummary,
  isUndoAnchor,
  planUndoCut,
  undo,
  type ContextUndoneEvent,
} from '#/builtin/undo/index';
import { createFeature } from '#/feature/index';
import {
  createUserEntry,
  createUserMessage,
  extractText,
  type HistoryMessage,
  type UserMeta,
} from '#/llm/message';
import { UNKNOWN_CAPABILITY, type LlmModel } from '#/llm/model';
import type { LlmRequester } from '#/llm/requester/requester';
import { openBlobs } from '#/store/blob';
import type { RecordEvent } from '#/store/journal';
import { MemoryBackend, Trees, type Branch } from '#/store/tree';
import { openSessionStores, type SessionStores } from '#/stores/session';

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

function userEntry(text: string, meta?: UserMeta): HistoryMessage {
  return createUserEntry(createUserMessage(text), meta);
}

const summaryEntry = userEntry('summary', { source: 'compaction', key: 'summary' });

interface TestEnv {
  backend: MemoryBackend;
  stores: SessionStores;
  app: AppHandle;
  session: SessionHandle;
  records: TelemetryAppenderRecord[];
}

async function testEnv(): Promise<TestEnv> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  const stores = await openSessionStores(tree, openBlobs(backend.blobs));
  const records: TelemetryAppenderRecord[] = [];
  const appender: TelemetryAppender = {
    track: (record) => {
      records.push(record);
    },
  };
  const recorder = createFeature('telemetry-recorder', {
    app() {
      useTelemetryAppender(appender);
    },
  });
  const app = createHarness({ features: [createTelemetry(), recorder, undo] });
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores });
  return { backend, stores, app, session, records };
}

async function startMain(env: TestEnv, requester?: LlmRequester): Promise<AgentHandle> {
  const agent = await env.session.create({ agentId: 'main' });
  agent.setConfig({ model });
  agent.setRequester(requester ?? createEchoRequester());
  return agent;
}

async function runTurn(agent: AgentHandle, text: string, meta?: UserMeta): Promise<void> {
  const done = new Promise<void>((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
  agent.submit(createUserMessage(text), meta);
  await done;
}

function historyTexts(stores: SessionStores, agentId: string): string[] {
  const store = stores.get(agentId);
  expect(store).toBeDefined();
  return (store as NonNullable<typeof store>).getState().history.map((entry) =>
    extractText(entry.message),
  );
}

async function expectUndoError(
  promise: Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code, message });
}

describe('undo anchors', () => {
  it('classifies undo anchors and compaction summaries', () => {
    expect(isUndoAnchor(userEntry('a'))).toBe(true);
    expect(isUndoAnchor(userEntry('a', { origin: { kind: 'user' } }))).toBe(true);
    expect(isUndoAnchor(userEntry('a', { origin: { kind: 'cron_job' } }))).toBe(false);
    expect(isUndoAnchor(userEntry('a', { source: 'reminder' }))).toBe(true);
    expect(
      isUndoAnchor({ message: { role: 'system', content: [{ type: 'text', text: 's' }] } }),
    ).toBe(false);
    expect(isCompactionSummary(summaryEntry)).toBe(true);
    expect(isCompactionSummary(userEntry('a'))).toBe(false);
    expect(isCompactionSummary(userEntry('a', { source: 'compaction', key: 'elision' }))).toBe(false);
  });

  it('computes availability backwards and stops at a compaction summary', () => {
    expect(computeUndoAvailability([])).toEqual({ maxTurns: 0, stoppedAtCompaction: false });
    expect(
      computeUndoAvailability([
        userEntry('a'),
        userEntry('b', { origin: { kind: 'cron_job' } }),
        userEntry('c'),
      ]),
    ).toEqual({ maxTurns: 2, stoppedAtCompaction: false });
    expect(computeUndoAvailability([userEntry('a'), summaryEntry, userEntry('b')])).toEqual({
      maxTurns: 1,
      stoppedAtCompaction: true,
    });
    expect(computeUndoAvailability([summaryEntry])).toEqual({
      maxTurns: 0,
      stoppedAtCompaction: true,
    });
  });

  it('plans the machine-turn cut across branch parents and stops at summaries', async () => {
    const backend = new MemoryBackend();
    const trees = await Trees.open(backend.trees, {});
    const tree = await trees.tree('sess');
    const append = (branch: Branch, data: RecordEvent): Promise<unknown> =>
      branch.append({ type: data.type, kind: 'event', data });
    const main = tree.createBranch('main');
    await append(main, { type: 'turn.started', turnId: 0 });
    await append(main, { type: 'message.appended', message: userEntry('a') });
    await append(main, { type: 'turn.ended', turnId: 0, outcome: 'done' });
    const child = tree.createBranch('main~2', { from: { branch: 'main', seq: 2 } });
    await append(child, { type: 'turn.started', turnId: 1 });
    await append(child, { type: 'message.appended', message: userEntry('b', { origin: { kind: 'cron_job' } }) });
    await append(child, { type: 'message.appended', message: userEntry('c') });
    await append(child, { type: 'turn.ended', turnId: 1, outcome: 'done' });
    expect(planUndoCut(tree, 'main~2', 1)).toEqual({ ok: true, machineTurns: 1, fromTurnId: 1 });
    expect(planUndoCut(tree, 'main~2', 2)).toEqual({ ok: true, machineTurns: 2, fromTurnId: 0 });
    expect(planUndoCut(tree, 'main~2', 3)).toEqual({ ok: false });
    const compacted = tree.createBranch('compacted');
    await append(compacted, { type: 'turn.started', turnId: 0 });
    await append(compacted, { type: 'message.appended', message: summaryEntry });
    await append(compacted, { type: 'turn.ended', turnId: 0, outcome: 'done' });
    await append(compacted, { type: 'turn.started', turnId: 1 });
    await append(compacted, { type: 'message.appended', message: userEntry('d') });
    await append(compacted, { type: 'turn.ended', turnId: 1, outcome: 'done' });
    expect(planUndoCut(tree, 'compacted', 1)).toEqual({ ok: true, machineTurns: 1, fromTurnId: 1 });
    expect(planUndoCut(tree, 'compacted', 2)).toEqual({ ok: false });
  });
});

describe('undo feature', () => {
  it('availability counts only user-origin anchors in the mounted store', async () => {
    const env = await testEnv();
    const agent = await startMain(env);
    await runTurn(agent, 'first');
    await runTurn(agent, 'cron', { origin: { kind: 'cron_job' } });
    await runTurn(agent, 'second');
    const face = agent.resolve(UndoRef);
    expect(face.availability()).toEqual({ maxTurns: 2, stoppedAtCompaction: false });
    await env.app.disposeAsync();
    await env.stores.dispose();
  });

  it('undo(1) truncates history, forks the branch, fires the event, and remounts', async () => {
    const env = await testEnv();
    const undone: ContextUndoneEvent[] = [];
    env.session.on(undo, 'context.undone', (event) => {
      undone.push(event);
    });
    const agent = await startMain(env);
    await runTurn(agent, 'first');
    await runTurn(agent, 'second');
    const face = agent.resolve(UndoRef);

    await expect(face.undo(1)).resolves.toBe(1);

    expect(undone).toHaveLength(1);
    expect(undone[0]).toMatchObject({
      type: 'context.undone',
      agentId: 'main',
      turns: 1,
      fromTurnId: 1,
    });
    expect(env.records.some((record) => record.event === 'conversation_undo')).toBe(true);
    expect(
      env.records.find((record) => record.event === 'conversation_undo')?.properties,
    ).toMatchObject({ count: 1 });
    expect(agent.state).toBe('unmounted');
    expect(historyTexts(env.stores, 'main')).toEqual(['first', 'echo:first']);
    expect(env.stores.branch('main')).toBe('main~2');
    expect(env.stores.session.getState().roster.agents['main']?.branch).toBe('main~2');
    const store = env.stores.get('main');
    expect(store?.getState().turnIndex.turns).toHaveLength(1);
    expect(store?.getState().turnIndex.nextTurnId).toBe(1);

    const fresh = env.session.get('main');
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(agent);
    (fresh as AgentHandle).setConfig({ model });
    (fresh as AgentHandle).setRequester(createEchoRequester());
    await runTurn(fresh as AgentHandle, 'third');
    expect(historyTexts(env.stores, 'main')).toEqual([
      'first',
      'echo:first',
      'third',
      'echo:third',
    ]);

    await env.app.disposeAsync();
    await env.stores.dispose();
  });

  it('undo(2) across an interleaved non-anchor turn removes all three turns', async () => {
    const env = await testEnv();
    const agent = await startMain(env);
    await runTurn(agent, 'first');
    await runTurn(agent, 'cron', { origin: { kind: 'cron_job' } });
    await runTurn(agent, 'second');
    const face = agent.resolve(UndoRef);

    await expect(face.undo(2)).resolves.toBe(2);

    expect(historyTexts(env.stores, 'main')).toEqual([]);
    expect(env.stores.branch('main')).toBe('main~2');
    expect(env.stores.get('main')?.getState().turnIndex.turns).toHaveLength(0);
    const fresh = env.session.get('main');
    expect(fresh).toBeDefined();

    await env.app.disposeAsync();
    await env.stores.dispose();
  });

  it('rejects with the verbatim error messages', async () => {
    const env = await testEnv();
    const agent = await startMain(env);
    const face = agent.resolve(UndoRef);

    await expectUndoError(face.undo(0), 'invalid-count', 'Undo count must be a positive safe integer');
    await expectUndoError(face.undo(1), 'empty', 'Nothing to undo: no user message to undo');
    expect(agent.snapshot.value?.context.paused).toBe(false);

    await runTurn(agent, 'only');
    await expectUndoError(
      face.undo(2),
      'insufficient',
      'Nothing to undo: only 1 of 2 requested turn(s) available',
    );
    expect(agent.snapshot.value?.context.paused).toBe(false);

    await env.stores.switchBranch('main', {
      reason: 'compaction',
      seed: [
        { type: 'turn.started', turnId: 1 },
        { type: 'message.appended', message: summaryEntry },
        { type: 'turn.ended', turnId: 1, outcome: 'done' },
      ],
    });
    expect(face.availability()).toEqual({ maxTurns: 0, stoppedAtCompaction: true });
    await expectUndoError(
      face.undo(1),
      'compaction-boundary',
      'Nothing to undo: would cross a compaction boundary',
    );
    expect(agent.snapshot.value?.context.paused).toBe(false);

    await env.app.disposeAsync();
    await env.stores.dispose();
  });

  it('rejects while a turn is running and while the agent is paused', async () => {
    const env = await testEnv();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = await startMain(env, {
      generate: (_config, _input, { onEvent }) =>
        gate.then(() => {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'slow' } });
          onEvent?.({ type: 'llm.done' });
        }),
    });
    const face = agent.resolve(UndoRef);
    const started = new Promise<void>((resolve) => {
      agent.on('turn.started', () => {
        resolve();
      });
    });
    const done = new Promise<void>((resolve) => {
      agent.on('turn.done', () => {
        resolve();
      });
    });
    agent.submit(createUserMessage('slow'));
    await started;
    expect(agent.snapshot.value?.matches('idle')).toBe(false);

    await expectUndoError(
      face.undo(1),
      'busy-turn',
      'Cannot undo while a turn is active or queued. Wait for it to finish, then retry.',
    );

    release();
    await done;
    expect(agent.snapshot.value?.matches('idle')).toBe(true);

    agent.pause();
    await expectUndoError(
      face.undo(1),
      'busy-compaction',
      'Cannot undo while conversation compaction is running. Wait for it to finish, then retry.',
    );
    agent.continue();
    expect(agent.snapshot.value?.context.paused).toBe(false);

    await env.app.disposeAsync();
    await env.stores.dispose();
  });

  it('persists the truncated history across a full reopen', async () => {
    const env = await testEnv();
    const agent = await startMain(env);
    await runTurn(agent, 'first');
    await runTurn(agent, 'second');
    await agent.resolve(UndoRef).undo(1);
    await env.stores.flush();
    await env.app.disposeAsync();
    await env.stores.dispose();

    const trees = await Trees.open(env.backend.trees, {});
    const tree = await trees.tree('sess');
    const stores = await openSessionStores(tree, openBlobs(env.backend.blobs));
    const app = createHarness({ features: [undo] });
    await app.ready();
    const session = await app.create({ sessionId: 'sess', stores });
    const reopened = await session.create({ agentId: 'main' });
    reopened.setConfig({ model });
    reopened.setRequester(createEchoRequester());

    expect(historyTexts(stores, 'main')).toEqual(['first', 'echo:first']);
    expect(stores.branch('main')).toBe('main~2');
    expect(stores.get('main')?.getState().turnIndex.turns).toHaveLength(1);
    expect(reopened.resolve(UndoRef).availability()).toEqual({
      maxTurns: 1,
      stoppedAtCompaction: false,
    });

    await runTurn(reopened, 'third');
    expect(historyTexts(stores, 'main')).toEqual(['first', 'echo:first', 'third', 'echo:third']);
    expect(stores.get('main')?.getState().turnIndex.nextTurnId).toBe(2);

    await app.disposeAsync();
    await stores.dispose();
  });
});
