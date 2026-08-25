import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentContext } from '#/agent/agentContext/agentContext';
import type { UsageRecordedContext, UsageStatus } from '#/agent/usage/usage';
import type { Event2 } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import { AgentUsage, type UsageRuntime } from '#/features/usage/usageAgentRuntime';
import type { TokenUsage } from '#/kosong/contract/usage';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { IWireService } from '#/wire/wire';

import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  type TestAgentContext,
} from '../../harness';

const a1: TokenUsage = { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 };
const a2: TokenUsage = { inputOther: 10, output: 20, inputCacheRead: 30, inputCacheCreation: 40 };
const b1: TokenUsage = { inputOther: 100, output: 200, inputCacheRead: 300, inputCacheCreation: 400 };

describe('Agent usage (AgentUsage)', () => {
  let ctx: TestAgentContext;
  let usage: UsageRuntime;

  beforeEach(() => {
    ctx = createTestAgent();
    usage = ctx.resolve(AgentUsage);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('accumulates usage by model', async () => {
    expect(await usage.recordTurn({ model: 'model-a', usage: a1 })).toBe(true);
    expect(await usage.recordTurn({ model: 'model-a', usage: a2 })).toBe(false);
    expect(await usage.recordTurn({ model: 'model-b', usage: b1 })).toBe(false);

    expect(usage.status()).toEqual({
      byModel: {
        'model-a': { inputOther: 11, output: 22, inputCacheRead: 33, inputCacheCreation: 44 },
        'model-b': b1,
      },
      total: { inputOther: 111, output: 222, inputCacheRead: 333, inputCacheCreation: 444 },
      currentTurn: undefined,
    });
  });

  it('tracks current turn usage by turn id', async () => {
    await usage.recordTurn({ model: 'model-a', usage: a1 });
    await usage.recordTurn({ model: 'model-a', usage: a2, source: { type: 'turn', turnId: 1 } });
    await usage.recordTurn({ model: 'model-b', usage: b1, source: { type: 'turn', turnId: 1 } });

    expect(usage.status()).toMatchObject({
      total: { inputOther: 111, output: 222, inputCacheRead: 333, inputCacheCreation: 444 },
      currentTurn: { inputOther: 110, output: 220, inputCacheRead: 330, inputCacheCreation: 440 },
    });

    await usage.recordTurn({
      model: 'model-a',
      usage: { inputOther: 5, output: 6, inputCacheRead: 7, inputCacheCreation: 8 },
      source: { type: 'turn', turnId: 2 },
    });

    expect(usage.status().currentTurn).toEqual({
      inputOther: 5,
      output: 6,
      inputCacheRead: 7,
      inputCacheCreation: 8,
    });
  });

  it('returns immutable status snapshots', async () => {
    await usage.recordTurn({ model: 'model-a', usage: a1 });
    const snapshot = usage.status();

    await usage.recordTurn({ model: 'model-a', usage: a2 });

    expect(snapshot).toEqual({
      byModel: { 'model-a': a1 },
      total: a1,
      currentTurn: undefined,
    });
  });

  it('emits agent.status.updated with the usage snapshot after each live record', async () => {
    const events: Event2[] = [];
    ctx.get(IEventBus).subscribe((event) => {
      if (event.type === 'agent.status.updated') events.push(event);
    });

    await usage.recordTurn({ model: 'model-a', usage: a1 });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'agent.status.updated',
        usage: {
          byModel: { 'model-a': a1 },
          total: a1,
          currentTurn: undefined,
        } satisfies UsageStatus,
      }),
    ]);
  });

  it('fires the runtime onDidRecord observation with the live usage context', async () => {
    const contexts: UsageRecordedContext[] = [];
    usage.onDidRecord((recorded) => {
      contexts.push(recorded);
    });

    await usage.recordTurn({
      model: 'model-a',
      usage: a1,
      source: { type: 'turn', turnId: 7, step: 2 },
    });

    expect(contexts).toEqual([
      {
        agent: ctx.agentContext,
        model: 'model-a',
        usage: a1,
        source: { type: 'turn', turnId: 7, step: 2 },
        firstRecord: true,
      },
    ]);
  });

  it('bridges the session usage service into the runtime with firstRecord semantics', async () => {
    const service = ctx.get(ISessionUsageService);
    const contexts: UsageRecordedContext[] = [];
    service.onDidRecord((recorded) => {
      contexts.push(recorded);
    });

    await ctx.usage.record('model-a', a1, { type: 'turn', turnId: 7, step: 2 });
    await ctx.usage.record('model-b', b1);
    await ctx.usage.record('model-a', a2);

    expect(contexts).toEqual([
      {
        agent: ctx.agentContext,
        model: 'model-a',
        usage: a1,
        source: { type: 'turn', turnId: 7, step: 2 },
        firstRecord: true,
      },
      { agent: ctx.agentContext, model: 'model-b', usage: b1, source: undefined, firstRecord: false },
      { agent: ctx.agentContext, model: 'model-a', usage: a2, source: undefined, firstRecord: false },
    ]);
    expect(service.status(ctx.agentContext).currentTurn).toEqual({
      inputOther: 1,
      output: 2,
      inputCacheRead: 3,
      inputCacheCreation: 4,
    });
  });

  it('rejects a context the lifecycle never issued', async () => {
    const service = ctx.get(ISessionUsageService);
    const forged = { agentId: 'main', generation: 999 } as AgentContext;

    await expect(service.record(forged, 'model-a', a1)).rejects.toThrow(
      'is not a lifecycle-issued context',
    );
    expect(() => service.status(forged)).toThrow('is not a lifecycle-issued context');
  });

  it('persists flat usage.record records with the recorded scope', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({ persistence });
    try {
      const liveUsage = live.resolve(AgentUsage);
      await liveUsage.recordTurn({ model: 'model-a', usage: a1 });
      await liveUsage.recordTurn({
        model: 'model-a',
        usage: a2,
        source: { type: 'turn', turnId: 7, step: 2 },
      });
      await live.get(IWireService).flush();

      const records = persistence.records.filter((record) => record.type === 'usage.record');
      expect(records).toEqual([
        {
          type: 'usage.record',
          agentId: 'main',
          model: 'model-a',
          usage: a1,
          usageScope: 'session',
          time: expect.any(Number),
        },
        {
          type: 'usage.record',
          agentId: 'main',
          model: 'model-a',
          usage: a2,
          usageScope: 'turn',
          time: expect.any(Number),
        },
      ]);
      expect(records.every((record) => !('payload' in record))).toBe(true);
    } finally {
      await live.dispose();
    }
  });

  it('does not mark firstRecord when usage was restored from persisted records', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({ persistence });
    try {
      await live.resolve(AgentUsage).recordTurn({ model: 'model-a', usage: a1 });
      await live.get(IWireService).flush();

      const resumed = createTestAgent({ persistence, autoConfigure: false });
      try {
        await resumed.restorePersisted();
        const contexts: UsageRecordedContext[] = [];
        resumed.get(ISessionUsageService).onDidRecord((recorded) => {
          contexts.push(recorded);
        });
        await resumed.usage.record('model-a', a2);

        expect(contexts).toHaveLength(1);
        expect(contexts[0]!.firstRecord).toBe(false);
      } finally {
        await resumed.dispose();
      }
    } finally {
      await live.dispose();
    }
  });

  it('replay rebuilds byModel totals without currentTurn and appends nothing', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({ persistence });
    const liveUsage = live.resolve(AgentUsage);
    await liveUsage.recordTurn({ model: 'model-a', usage: a1 });
    await liveUsage.recordTurn({
      model: 'model-a',
      usage: a2,
      source: { type: 'turn', turnId: 1 },
    });
    await live.get(IWireService).flush();
    await live.dispose();
    const written = persistence.records.filter((record) => record.type === 'usage.record');

    const resumed = createTestAgent({ persistence, autoConfigure: false });
    try {
      await resumed.restorePersisted();

      expect(resumed.resolve(AgentUsage).status()).toEqual({
        byModel: {
          'model-a': { inputOther: 11, output: 22, inputCacheRead: 33, inputCacheCreation: 44 },
        },
        total: { inputOther: 11, output: 22, inputCacheRead: 33, inputCacheCreation: 44 },
        currentTurn: undefined,
      });
      expect(persistence.records.filter((record) => record.type === 'usage.record')).toEqual(
        written,
      );
    } finally {
      await resumed.dispose();
    }
  });

  it('replays legacy turn context records into byModel totals only', async () => {
    const persistence = new InMemoryWireRecordPersistence([
      {
        type: 'usage.record',
        model: 'model-a',
        usage: a1,
        usageScope: 'turn',
        turnId: 1,
        context: { type: 'turn', turnId: 9, step: 3 },
      },
    ]);
    const replayed = createTestAgent({ persistence, autoConfigure: false });
    try {
      await replayed.restorePersisted();

      expect(replayed.resolve(AgentUsage).status()).toEqual({
        byModel: { 'model-a': a1 },
        total: a1,
        currentTurn: undefined,
      });
    } finally {
      await replayed.dispose();
    }
  });
});
