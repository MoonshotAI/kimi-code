import { describe, expect, it } from 'vitest';
import { createActor, waitFor } from '#/xstate2';

import { connectPlugins } from '#/plugin';
import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createUserMessage } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import type { LlmRequester } from '#/llm/requester/requester';
import type { TokenUsage } from '#/llm/usage';
import { createAgentMachine } from '#/agent/machine';
import { agentSlices, type AgentEventStore } from '#/agent/slices';
import { createTurnMachine } from '#/agent/turn';
import { createEventStore } from '#/eventStore/eventStore';
import { journalFromBranch } from '#/eventStore/journal';
import { MemoryBackend } from '#/store/backend/memory';
import { TreeStore } from '#/store/store';
import { createUsageMachine } from '#/usage/machine';
import type { UsageEmitted } from '#/usage/machine';
import { createUsagePlugin } from '#/usage/plugin';
import type { UsageRecord } from '#/usage/usage';
import { createTimingPlugin } from '#/timing/plugin';
import {
  xstateInspectionCollector,
  type XstateInspectionEnvelope,
} from '#/xstateInspection';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

function usage(inputOther: number, output: number): TokenUsage {
  return { inputOther, output, inputCacheRead: 0, inputCacheCreation: 0 };
}

function record(
  inputOther: number,
  output: number,
  extra?: { model?: LlmModel; turnId?: number },
): UsageRecord {
  return { usage: usage(inputOther, output), model: extra?.model, turnId: extra?.turnId, at: 0 };
}

async function testStore(): Promise<AgentEventStore> {
  const backend = new MemoryBackend();
  const store = await TreeStore.open(backend, {});
  const tree = await store.tree('test');
  tree.createBranch('main');
  return createEventStore({ journal: journalFromBranch(tree.openBranch('main'), tree), slices: agentSlices });
}

describe('xstate inspection collector', () => {
  it('publishes JSON-safe scalar envelopes with no machine context', () => {
    const envelopes: XstateInspectionEnvelope[] = [];
    const unsubscribe = xstateInspectionCollector.subscribe((envelope) => envelopes.push(envelope));
    try {
      const actor = createActor(createUsageMachine());
      actor.start();
      actor.send({ type: 'usage.record', record: record(10, 2, { model, turnId: 1 }) });
    } finally {
      unsubscribe();
    }
    const delivered = envelopes.filter((envelope) => envelope.eventType === 'usage.record');
    expect(delivered.length).toBeGreaterThan(0);
    for (const envelope of delivered) {
      expect(typeof envelope.actorSessionId).toBe('string');
      expect(typeof envelope.timestamp).toBe('number');
    }
    expect(delivered.find((envelope) => envelope.type === '@xstate.microstep')?.stateValue).toBeDefined();
    const serialized = JSON.stringify(envelopes);
    expect(serialized).not.toContain('inputOther');
    expect(JSON.parse(serialized)).toEqual(envelopes);
  });
});

describe('usage machine', () => {
  it('groups byModel by baseUrl + model, ignoring provider', () => {
    const actor = createActor(createUsageMachine());
    actor.start();

    const a1: LlmModel = { provider: 'p1', model: 'm', capability: UNKNOWN_CAPABILITY, baseUrl: 'https://a.test/v1' };
    const a2: LlmModel = { provider: 'p2', model: 'm', capability: UNKNOWN_CAPABILITY, baseUrl: 'https://a.test/v1' };
    const b: LlmModel = { provider: 'p1', model: 'm', capability: UNKNOWN_CAPABILITY, baseUrl: 'https://b.test/v1' };
    actor.send({ type: 'usage.record', record: record(10, 2, { model: a1 }) });
    actor.send({ type: 'usage.record', record: record(5, 3, { model: a2 }) });
    actor.send({ type: 'usage.record', record: record(1, 1, { model: b }) });

    const { summary } = actor.getSnapshot().context;
    expect(summary.byModel).toEqual({
      'https://a.test/v1#m': { inputOther: 15, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
      'https://b.test/v1#m': { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
    });
  });

  it('emits usage.updated with the record and running summary', () => {
    const actor = createActor(createUsageMachine());
    const emitted: UsageEmitted[] = [];
    actor.on('usage.updated', (event) => emitted.push(event));
    actor.start();

    actor.send({ type: 'usage.record', record: record(10, 2, { model, turnId: 1 }) });
    actor.send({ type: 'usage.record', record: record(5, 3, { model, turnId: 1 }) });

    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.record.usage).toEqual(usage(5, 3));
    expect(emitted[1]?.summary.total).toEqual({
      inputOther: 15,
      output: 5,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    expect(emitted[1]?.summary.byTurn[1]).toEqual({
      inputOther: 15,
      output: 5,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });
});

describe('usage plugin', () => {
  it('collects usage from every llm.streaming.usage and groups it by turn', async () => {
    const ticks = [1000, 1100, 1200, 1230, 1300, 2000, 2100, 2200, 2240, 2300];
    const requester: LlmRequester = {
      generate: (_config, _content, { onEvent }) => {
        onEvent?.({ type: 'llm.sent' });
        onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'ok' } });
        onEvent?.({ type: 'llm.streaming.usage', usage: usage(10, 2) });
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      },
    };
    const plugin = createUsagePlugin({ model });
    const timingPlugin = createTimingPlugin({ now: () => ticks.shift() ?? Number.NaN });
    const store = await testStore();
    const actor = createActor(
      createAgentMachine({
        turnActor: createTurnMachine(requester),
      }),
      { input: { request: { model }, store } },
    );
    connectPlugins(actor, [plugin, timingPlugin]);
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });
    actor.send({ type: 'input.submit', message: createUserMessage('again') });
    await waitFor(
      actor,
      (s) => s.matches('idle') && store.getState().history.length === 4,
      { timeout: 5000 },
    );

    const { records, summary } = plugin.actor.getSnapshot().context;
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.turnId)).toEqual([0, 1]);
    expect(records.map((r) => r.model)).toEqual([model, model]);
    expect(summary.total).toEqual({
      inputOther: 20,
      output: 4,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    expect(summary.byModel['test-model']).toEqual(summary.total);
    expect(summary.byTurn[0]).toEqual({
      inputOther: 10,
      output: 2,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    expect(summary.byTurn[1]).toEqual(summary.byTurn[0]);

    expect(timingPlugin.timing()).toEqual({
      requestBuildMs: 100,
      ttftMs: 200,
      serverFirstTokenMs: 100,
      streamDurationMs: 100,
      serverDecodeMs: 60,
      clientConsumeMs: 40,
    });
    expect(ticks).toHaveLength(0);
  });
});
