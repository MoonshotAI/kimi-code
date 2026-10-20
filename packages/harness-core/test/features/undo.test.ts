import { describe, expect, it } from 'vitest';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import {
  createUserEntry,
  type HistoryMessage,
  type UserMeta,
} from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import { createAssistantMessage, createUserMessage, extractText } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester, LoopRecord } from '@moonshot-ai/agent-core/loop/index';
import type { Agent } from '@moonshot-ai/agent-core/session/index';
import type { Entry, Projection } from '@moonshot-ai/agent-core/store/index';

import {
  createTelemetry,
  useTelemetryAppender,
  type TelemetryAppenderRecord,
} from '#/features/telemetry/index';
import {
  UndoRef,
  computeUndoAvailability,
  isCompactionSummary,
  isUndoAnchor,
  planUndoCut,
  undo,
  type ContextUndoneEvent,
  type UndoFace,
} from '#/features/undo/index';
import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  useFeatureStore,
  type FeatureStore,
  type Harness,
} from '#/runtime/index';

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

function textOutcome(text: string): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }]) };
}

function scriptedRequester(next: (rest: GenerateRest) => LlmOutcome | Promise<LlmOutcome>): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest, _control) => next(rest),
  };
  return self;
}

function echoRequester(): LoopLlmRequester {
  return scriptedRequester((rest) => {
    const messages = rest.content?.messages ?? [];
    const last = messages.at(-1);
    const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
    return textOutcome(`echo:${text}`);
  });
}

function userEntry(text: string, meta?: UserMeta) {
  return createUserEntry(createUserMessage(text), meta);
}

function user(text: string, meta?: UserMeta) {
  return createUserEntry(createUserMessage(text), { source: 'input', ...meta });
}

const summaryEntry = userEntry('summary', { source: 'compaction', key: 'summary' });

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface ProbeState {
  readonly values: readonly string[];
}

type ProbeEvent = { readonly type: 'probe.set'; readonly value: string; readonly turnId?: number };

const probeProjection: Projection<ProbeState, ProbeEvent> = {
  initial: () => ({ values: [] }),
  reduce: (state, entry) =>
    entry.event.type === 'probe.set' ? { values: [...state.values, entry.event.value] } : state,
};

interface TestEnv {
  harness: Harness;
  agent: Agent;
  face: () => UndoFace | undefined;
  store: () => FeatureStore<ProbeState, ProbeEvent> | undefined;
  records: TelemetryAppenderRecord[];
}

async function testEnv(requester: LoopLlmRequester = echoRequester()): Promise<TestEnv> {
  const harness = createHarness({ space: memoryHarnessSpace() });
  const records: TelemetryAppenderRecord[] = [];
  const recorder = createFeature('telemetry-recorder', {
    app: () => {
      useTelemetryAppender({
        track: (record) => {
          records.push(record);
        },
      });
    },
  });
  let face: Readonly<ShallowRef<UndoFace | undefined>> | undefined;
  let store: FeatureStore<ProbeState, ProbeEvent> | undefined;
  const probe = createFeature('undo-probe', {
    agent: () => {
      face = useInject(UndoRef);
      store = useFeatureStore('agent', 'undo-probe', probeProjection);
    },
  });
  await harness.app.features.add(createTelemetry());
  await harness.app.features.add(recorder);
  await harness.app.features.add(undo);
  await harness.app.features.add(probe);
  const session = await harness.app.create({ sessionId: 's1' });
  const agent = await harness.ensureAgent(session, 'main');
  setRequester(harness, 's1', 'main', requester);
  await tick();
  return { harness, agent, face: () => face?.value, store: () => store, records };
}

async function runTurn(agent: Agent, text: string, meta?: UserMeta): Promise<void> {
  await agent.loop.runTurn(user(text, meta));
  await agent.flush();
}

function historyTexts(agent: Agent): string[] {
  return agent.view.getState().messages.map((entry) => extractText(entry.message));
}

async function expectUndoError(promise: Promise<unknown>, code: string, message: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code, message });
}

function recordedEntries(build: (rec: (event: LoopRecord) => Entry<LoopRecord>) => void): Entry<LoopRecord>[] {
  const entries: Entry<LoopRecord>[] = [];
  build((event) => {
    const entry: Entry<LoopRecord> = { seq: entries.length, time: 0, event };
    entries.push(entry);
    return entry;
  });
  return entries;
}

const started = (turnId: number): LoopRecord => ({ type: 'turn.started', turnId, trigger: 'normal' });
const ended = (turnId: number): LoopRecord => ({ type: 'turn.ended', turnId, outcome: { type: 'done' } });
const appended = (entry: HistoryMessage, turnId: number): LoopRecord => ({
  type: 'message.appended',
  turnId,
  step: 0,
  source: 'normal',
  entry,
});

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

  it('plans the machine-turn cut and stops at summaries', () => {
    const entries = recordedEntries((rec) => {
      rec(started(0));
      rec(appended(userEntry('a'), 0));
      rec(ended(0));
      rec(started(1));
      rec(appended(userEntry('b', { origin: { kind: 'cron_job' } }), 1));
      rec(appended(userEntry('c'), 1));
      rec(ended(1));
    });
    expect(planUndoCut(entries, 1)).toEqual({ ok: true, machineTurns: 1, fromTurnId: 1 });
    expect(planUndoCut(entries, 2)).toEqual({ ok: true, machineTurns: 2, fromTurnId: 0 });
    expect(planUndoCut(entries, 3)).toEqual({ ok: false });

    const compacted = recordedEntries((rec) => {
      rec(started(0));
      rec(appended(summaryEntry, 0));
      rec(ended(0));
      rec(started(1));
      rec(appended(userEntry('d'), 1));
      rec(ended(1));
    });
    expect(planUndoCut(compacted, 1)).toEqual({ ok: true, machineTurns: 1, fromTurnId: 1 });
    expect(planUndoCut(compacted, 2)).toEqual({ ok: false });

    const reset = recordedEntries((rec) => {
      rec(started(0));
      rec(appended(userEntry('a'), 0));
      rec(ended(0));
      rec({ type: 'context.settled', messages: [summaryEntry] });
      rec(started(1));
      rec(appended(userEntry('d'), 1));
      rec(ended(1));
    });
    expect(planUndoCut(reset, 1)).toEqual({ ok: true, machineTurns: 1, fromTurnId: 1 });
    expect(planUndoCut(reset, 2)).toEqual({ ok: false });

    const tailReset = recordedEntries((rec) => {
      rec(started(0));
      rec(appended(userEntry('a'), 0));
      rec(ended(0));
      rec({ type: 'context.settled', messages: [summaryEntry] });
    });
    expect(planUndoCut(tailReset, 1)).toEqual({ ok: false });
  });
});

describe('undo feature', () => {
  it('availability counts only user-origin anchors in the mounted agent', async () => {
    const env = await testEnv();
    await runTurn(env.agent, 'first');
    await runTurn(env.agent, 'cron', { origin: { kind: 'cron_job' } });
    await runTurn(env.agent, 'second');
    const face = env.face()!;
    expect(face.availability()).toEqual({ maxTurns: 2, stoppedAtCompaction: false });
    await env.harness.close();
  });

  it('undo(1) truncates history, fires the event, tracks telemetry and rewinds feature stores', async () => {
    const env = await testEnv();
    const undone: ContextUndoneEvent[] = [];
    env.harness.app.on(undo, 'context.undone', (event) => {
      undone.push(event);
    });
    await runTurn(env.agent, 'first');
    const store = env.store()!;
    await store.dispatch([{ type: 'probe.set', value: 'turn-1' }]);
    await runTurn(env.agent, 'second');
    await store.dispatch([{ type: 'probe.set', value: 'turn-2' }]);
    expect(store.state.value.values).toEqual(['turn-1', 'turn-2']);
    const face = env.face()!;

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
    expect(env.harness.app.sessions.get('s1')?.agents.get('main')).toBe(env.agent);
    expect(historyTexts(env.agent)).toEqual(['first', 'echo:first']);
    expect(env.agent.view.getState().turns).toHaveLength(1);
    expect(env.agent.view.getState().nextTurnId).toBe(1);
    expect(store.state.value.values).toEqual(['turn-1']);

    await runTurn(env.agent, 'third');
    expect(historyTexts(env.agent)).toEqual(['first', 'echo:first', 'third', 'echo:third']);
    expect(env.agent.view.getState().turns.map((turn) => turn.turnId)).toEqual([0, 2]);
    expect(env.agent.view.getState().nextTurnId).toBe(3);

    await env.harness.close();
  });

  it('undo(2) across an interleaved non-anchor turn removes all three turns', async () => {
    const env = await testEnv();
    await runTurn(env.agent, 'first');
    await runTurn(env.agent, 'cron', { origin: { kind: 'cron_job' } });
    await runTurn(env.agent, 'second');
    const face = env.face()!;

    await expect(face.undo(2)).resolves.toBe(2);

    expect(historyTexts(env.agent)).toEqual([]);
    expect(env.agent.view.getState().turns).toHaveLength(0);
    expect(env.agent.view.getState().nextTurnId).toBe(0);

    await runTurn(env.agent, 'third');
    expect(historyTexts(env.agent)).toEqual(['third', 'echo:third']);

    await env.harness.close();
  });

  it('rejects with the verbatim error messages', async () => {
    const env = await testEnv();
    const face = env.face()!;

    await expectUndoError(face.undo(0), 'invalid-count', 'Undo count must be a positive safe integer');
    await expectUndoError(face.undo(1), 'empty', 'Nothing to undo: no user message to undo');
    expect(env.agent.loop.state.status).toBe('idle');

    await runTurn(env.agent, 'only');
    await expectUndoError(
      face.undo(2),
      'insufficient',
      'Nothing to undo: only 1 of 2 requested turn(s) available',
    );
    expect(env.agent.loop.state.status).toBe('idle');

    env.agent.loop.setContext([summaryEntry], 'compaction');
    await env.agent.flush();
    expect(face.availability()).toEqual({ maxTurns: 0, stoppedAtCompaction: true });
    await expectUndoError(
      face.undo(1),
      'compaction-boundary',
      'Nothing to undo: would cross a compaction boundary',
    );
    expect(env.agent.loop.state.status).toBe('idle');

    await env.harness.close();
  });

  it('rejects while a turn is running', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const env = await testEnv(scriptedRequester(() => gate.then(() => textOutcome('slow'))));
    const face = env.face()!;
    const startedEvent = env.agent.loop.wait('turn.started');
    env.agent.loop.submit(user('slow'));
    await startedEvent;
    expect(env.agent.loop.state.status).toBe('running');

    await expectUndoError(
      face.undo(1),
      'busy-turn',
      'Cannot undo while a turn is active or queued. Wait for it to finish, then retry.',
    );

    release();
    await env.agent.loop.waitForIdle();
    await env.agent.flush();
    expect(env.agent.loop.state.status).toBe('idle');
    expect(historyTexts(env.agent)).toEqual(['slow', 'slow']);

    await env.harness.close();
  });

  it('persists the truncated history across a full reopen', async () => {
    const env = await testEnv();
    await runTurn(env.agent, 'first');
    await runTurn(env.agent, 'second');
    await env.face()!.undo(1);

    await env.harness.app.close('s1');
    const resumed = await env.harness.app.create({ sessionId: 's1' });
    const reopened = await env.harness.ensureAgent(resumed, 'main');
    setRequester(env.harness, 's1', 'main', echoRequester());
    await tick();

    expect(historyTexts(reopened)).toEqual(['first', 'echo:first']);
    expect(reopened.view.getState().turns).toHaveLength(1);
    expect(reopened.view.getState().nextTurnId).toBe(1);
    expect(env.face()!.availability()).toEqual({ maxTurns: 1, stoppedAtCompaction: false });

    await runTurn(reopened, 'third');
    expect(historyTexts(reopened)).toEqual(['first', 'echo:first', 'third', 'echo:third']);
    expect(reopened.view.getState().nextTurnId).toBe(2);

    await env.harness.close();
  });
});
