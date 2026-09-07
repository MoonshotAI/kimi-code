import { describe, expect, it } from 'vitest';
import { createActor, waitFor } from '#/xstate2';

import { connectPlugins } from '#/plugin';
import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createUserMessage } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { createLlmMachine } from '#/llm/requester/machine';
import type { LlmRequester } from '#/llm/requester/requester';
import type { TokenUsage } from '#/llm/usage';
import { createAgentMachine } from '#/agent/machine';
import { createTurnMachine } from '#/agent/turn';
import { createUsageMachine } from '#/usage/machine';
import type { UsageEmitted } from '#/usage/machine';
import { createUsagePlugin } from '#/usage/plugin';
import type { UsageRecord } from '#/usage/usage';
import { createTimingPlugin } from '#/timing/plugin';

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

describe('usage machine', () => {
  it('accumulates total, byModel and byTurn across usage.record events', () => {
    const actor = createActor(createUsageMachine());
    actor.start();

    actor.send({ type: 'usage.record', record: record(10, 2, { model, turnId: 1 }) });
    actor.send({ type: 'usage.record', record: record(5, 3, { model, turnId: 2 }) });
    actor.send({ type: 'usage.record', record: record(100, 0) });

    const { records, summary } = actor.getSnapshot().context;
    expect(records).toHaveLength(3);
    expect(summary.total).toEqual({
      inputOther: 115,
      output: 5,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    expect(summary.byModel).toEqual({
      'test-model': { inputOther: 15, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
    });
    expect(summary.byTurn).toEqual({
      1: { inputOther: 10, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
      2: { inputOther: 5, output: 3, inputCacheRead: 0, inputCacheCreation: 0 },
    });
  });

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
  it('collects usage from every llm.usage and groups it by turn', async () => {
    const ticks = [1000, 1100, 1200, 1230, 1300, 2000, 2100, 2200, 2240, 2300];
    const requester: LlmRequester = {
      generate: (_config, _content, { onEvent }) => {
        onEvent?.({ type: 'llm.sent' });
        onEvent?.({ type: 'llm.delta', part: { type: 'text', text: 'ok' } });
        onEvent?.({ type: 'llm.usage', usage: usage(10, 2) });
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      },
    };
    const plugin = createUsagePlugin({ model });
    const timingPlugin = createTimingPlugin({ now: () => ticks.shift() ?? Number.NaN });
    const actor = createActor(
      createAgentMachine({
        turnActor: createTurnMachine(createLlmMachine({ requester })),
      }),
      { input: { request: { model } } },
    );
    connectPlugins(actor, [plugin, timingPlugin]);
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('hi') });
    actor.send({ type: 'input.submit', message: createUserMessage('again') });
    await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length === 4,
      { timeout: 5000 },
    );

    const { records, summary } = plugin.actor.getSnapshot().context;
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.turnId)).toEqual([1, 2]);
    expect(records.map((r) => r.model)).toEqual([model, model]);
    expect(summary.total).toEqual({
      inputOther: 20,
      output: 4,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    expect(summary.byModel['test-model']).toEqual(summary.total);
    expect(summary.byTurn[1]).toEqual({
      inputOther: 10,
      output: 2,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    expect(summary.byTurn[2]).toEqual(summary.byTurn[1]);

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
