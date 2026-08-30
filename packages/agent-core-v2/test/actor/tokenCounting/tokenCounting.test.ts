import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentContextMemory, AgentProfile, type ContextMemoryRuntime, type ProfileRuntime } from '#/index';
import { TurnEnded } from '#/actor/loop/turnOps';
import { ContextAppendMessage } from '#/actor/contextMemory/contextEvents';
import {
  TokenCountingMeasured,
  TokenCountingTurnRecorded,
} from '#/actor/tokenCounting/tokenCountingOps';
import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import type { TokenUsage } from '#/kosong/contract/usage';
import { IWireService } from '#/wire/wire';

import { createTestAgent, InMemoryWireRecordPersistence, type TestAgentContext } from '../../harness';

function totalOf(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  return usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation;
}

describe('Agent token counting (AgentTokenCounting)', () => {
  let ctx: TestAgentContext;
  let context: ContextMemoryRuntime;
  let tokenCounting: TestAgentContext['tokenCounting'];
  let profile: ProfileRuntime;
  let usage: TestAgentContext['usage'];

  beforeEach(() => {
    ctx = createTestAgent();
    context = ctx.resolve(AgentContextMemory);
    tokenCounting = ctx.tokenCounting;
    profile = ctx.resolve(AgentProfile);
    usage = ctx.usage;
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('adopts the exchange totals as the measured context size after a turn', async () => {
    profile.update({ activeToolNames: [] });

    ctx.mockNextResponse({ type: 'text', text: 'Hi there!' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await ctx.untilTurnEnd();

    const exchangeTotal = totalOf(usage.status().total);
    expect(exchangeTotal).toBeGreaterThan(0);
    expect(context.get()).toHaveLength(2);

    const size = tokenCounting.get();
    expect(size.measured).toBe(exchangeTotal);
    expect(size.estimated).toBe(0);
    expect(size.size).toBe(exchangeTotal);
    expect(tokenCounting.latestMeasured()).toBe(exchangeTotal);
    expect((await ctx.rpc.getContext({})).tokenCount).toBe(exchangeTotal);
  });

  it('repoints the measured size at the last exchange across turns', async () => {
    profile.update({ activeToolNames: [] });

    ctx.mockNextResponse({ type: 'text', text: 'first' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await ctx.untilTurnEnd();

    ctx.mockNextResponse({ type: 'text', text: 'second reply, a longer one' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'again' }] });
    await ctx.untilTurnEnd();

    const lastExchangeTotal = totalOf(usage.status().currentTurn);
    expect(lastExchangeTotal).toBeGreaterThan(0);
    expect(context.get()).toHaveLength(4);

    expect(tokenCounting.get().measured).toBe(lastExchangeTotal);
    expect(tokenCounting.latestMeasured()).toBe(lastExchangeTotal);
    expect((await ctx.rpc.getContext({})).tokenCount).toBe(lastExchangeTotal);
  });

  it('estimates the not-yet-measured tail instead of dropping it', () => {
    ctx.appendUserMessage([{ type: 'text', text: 'hello world, not measured yet' }]);

    const size = tokenCounting.get();
    expect(size.measured).toBe(0);
    expect(size.estimated).toBeGreaterThan(0);
    expect(size.size).toBe(size.estimated);
  });

  it('ignores a stored anchor that overshoots the live context', async () => {
    ctx.appendUserMessage([{ type: 'text', text: 'only one message' }]);

    await ctx.dispatcher.dispatch(new TokenCountingMeasured({ agentId: 'main', length: 5, tokens: 1234 }));
    const size = tokenCounting.get();
    expect(size.measured).toBe(0);
    expect(size.size).toBe(estimateTokensForMessages(context.get()));
  });

  it('ignores a measured report whose input does not match the live context', () => {
    ctx.appendUserMessage([{ type: 'text', text: 'real tail' }]);

    const report: TokenUsage = { inputOther: 100, output: 1, inputCacheRead: 0, inputCacheCreation: 0 };
    tokenCounting.measured(
      [{ role: 'user', content: [{ type: 'text', text: 'foreign' }], toolCalls: [] }],
      [],
      report,
    );
    expect(tokenCounting.get().measured).toBe(0);
    expect(tokenCounting.latestMeasured()).toBe(0);

    tokenCounting.measured(context.get(), [], report);
    expect(tokenCounting.get().measured).toBe(101);
    expect(tokenCounting.latestMeasured()).toBe(101);
  });

  it('restores the REAL size of the surviving prefix when undo truncates the ledger', async () => {
    ctx.appendTurnExchange('u1', 'a1', 1_000);
    ctx.appendTurnExchange('u2', 'a2', 2_000);
    expect(tokenCounting.get()).toEqual({ size: 2_000, measured: 2_000, estimated: 0 });

    await ctx.undoHistory(1);

    expect(context.get().map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(tokenCounting.get()).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });
    expect(tokenCounting.latestMeasured()).toBe(1_000);
  });

  it('rebases the ledger on compaction and blends in the measured summary tokens', () => {
    ctx.appendTurnExchange('u1', 'a1', 1_000);
    expect(tokenCounting.latestMeasured()).toBe(1_000);

    void context.applyCompaction({
      summary: 'summary of u1',
      compactedCount: 2,
      tokensBefore: 1_000,
      summaryOutputTokens: 500,
    });

    const history = context.get();
    const kept = estimateTokensForMessages(history.filter((m) => m.origin?.kind === 'user'));
    const expected = 500 + kept;
    expect(tokenCounting.get()).toEqual({ size: expected, measured: expected, estimated: 0 });
    expect(tokenCounting.latestMeasured()).toBe(0);
  });

  it('resets the ledger when the context is cleared', () => {
    ctx.appendAssistantTextWithUsage(1, 'answer', 1_000);
    expect(tokenCounting.get().measured).toBe(1_000);

    void context.clear();

    expect(tokenCounting.get()).toEqual({ size: 0, measured: 0, estimated: 0 });
    expect(tokenCounting.latestMeasured()).toBe(0);
  });

  it('keeps estimates and anchors live for internal reads under the measured strategy', () => {
    const measured = createTestAgent({ initialConfig: { tokenCounting: { strategy: 'measured' } } });
    try {
      const counting = measured.tokenCounting;
      expect(counting.strategy).toBe('measured');
      expect(counting.estimateText('abcd')).toBeGreaterThan(0);

      measured.appendUserMessage([{ type: 'text', text: 'hello world, not measured yet' }]);
      const tailEstimate = estimateTokensForMessages(
        measured.resolve(AgentContextMemory).get(),
      );
      expect(tailEstimate).toBeGreaterThan(0);
      expect(counting.get()).toEqual({ size: tailEstimate, measured: 0, estimated: tailEstimate });

      measured.appendTurnExchange('u1', 'a1', 1_000);
      expect(counting.get().measured).toBe(1_000);
    } finally {
      void measured.dispose();
    }
  });

  it('keeps anchors in internal reads under the estimated strategy', () => {
    const estimated = createTestAgent({
      initialConfig: { tokenCounting: { strategy: 'estimated' } },
    });
    try {
      const counting = estimated.tokenCounting;
      expect(counting.strategy).toBe('estimated');

      estimated.appendTurnExchange('u1', 'a1', 1_000);
      expect(counting.get()).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });
    } finally {
      void estimated.dispose();
    }
  });

  it('keeps the measured size across a close → resume round trip', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({ persistence });
    try {
      live.appendTurnExchange('u1', 'a1', 1_000);
      live.appendTurnExchange('u2', 'a2', 2_000);
      const liveCounting = live.tokenCounting;
      expect(liveCounting.statusSize()).toBe(2_000);
      await live.get(IWireService).flush();

      expect(persistence.records.map((record) => record.type)).toContain('token_counting.measured');

      const resumed = createTestAgent({ persistence, autoConfigure: false });
      try {
        await resumed.restorePersisted();
        const resumedCounting = resumed.tokenCounting;
        expect(resumedCounting.get()).toEqual(liveCounting.get());
        expect(resumedCounting.latestMeasured()).toBe(2_000);
        expect(resumedCounting.statusSize()).toBe(liveCounting.statusSize());

        await resumed.undoHistory(1);
        expect(resumedCounting.get()).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });
      } finally {
        await resumed.dispose();
      }
    } finally {
      await live.dispose();
    }
  });

  it('replays a legacy journal into the same ledger projections', async () => {
    const persistence = new InMemoryWireRecordPersistence([
      new ContextAppendMessage({
        agentId: 'main',
        message: { role: 'user', content: [{ type: 'text', text: 'u1' }], toolCalls: [] },
      }, 1).serialize(),
      new ContextAppendMessage({
        agentId: 'main',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }], toolCalls: [] },
      }, 2).serialize(),
      new TokenCountingMeasured({ agentId: 'main', length: 2, tokens: 1_000 }, 3).serialize(),
      new ContextAppendMessage({
        agentId: 'main',
        message: { role: 'user', content: [{ type: 'text', text: 'u2' }], toolCalls: [] },
      }, 4).serialize(),
      new ContextAppendMessage({
        agentId: 'main',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a2' }], toolCalls: [] },
      }, 5).serialize(),
      new TokenCountingMeasured({ agentId: 'main', length: 4, tokens: 2_000 }, 6).serialize(),
      new TokenCountingTurnRecorded({ agentId: 'main', turnId: 0, length: 4, tokens: 2_000 }, 7).serialize(),
    ]);
    const replayed = createTestAgent({ persistence, autoConfigure: false });
    try {
      await replayed.restorePersisted();
      const counting = replayed.tokenCounting;
      expect(counting.get()).toEqual({ size: 2_000, measured: 2_000, estimated: 0 });
      expect(counting.latestMeasured()).toBe(2_000);
      expect(counting.statusSize()).toBe(2_000);

      await replayed.undoHistory(1);
      expect(counting.get()).toEqual({ size: 1_000, measured: 1_000, estimated: 0 });
    } finally {
      await replayed.dispose();
    }
  });

  it('statusSize reports the strategy-selected reading', () => {
    const measured = createTestAgent({ initialConfig: { tokenCounting: { strategy: 'measured' } } });
    try {
      const counting = measured.tokenCounting;
      expect(counting.statusSize()).toBe(0);

      measured.appendTurnExchange('u1', 'a1', 1_000);
      measured.appendUserMessage([{ type: 'text', text: 'not measured yet' }]);
      expect(counting.statusSize()).toBe(1_000);
    } finally {
      void measured.dispose();
    }

    const estimated = createTestAgent({
      initialConfig: { tokenCounting: { strategy: 'estimated' } },
    });
    try {
      const counting = estimated.tokenCounting;
      estimated.appendTurnExchange('u1', 'a1', 1_000_000);
      const estimate = estimateTokensForMessages(estimated.resolve(AgentContextMemory).get());
      expect(counting.latestMeasured()).toBe(1_000_000);
      expect(counting.statusSize()).toBe(estimate);
    } finally {
      void estimated.dispose();
    }

    ctx.appendTurnExchange('u1', 'a1', 1_000);
    expect(tokenCounting.statusSize()).toBe(
      Math.max(tokenCounting.get().size, tokenCounting.latestMeasured()),
    );
  });

  it('journals the reported size as a durable record at every turn end', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({ persistence });
    try {
      live.resolve(AgentProfile).update({ activeToolNames: [] });

      live.mockNextResponse({ type: 'text', text: 'Hi there!' });
      await live.rpc.prompt({ input: [{ type: 'text', text: 'hi' }] });
      await live.untilTurnEnd();

      const counting = live.tokenCounting;
      const reported = counting.statusSize();
      expect(reported).toBeGreaterThan(0);
      await live.get(IWireService).flush();

      const records = persistence.records.filter(
        (record) => record.type === 'token_counting.turn_recorded',
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        agentId: 'main',
        turnId: 0,
        length: live.resolve(AgentContextMemory).get().length,
        tokens: reported,
      });
      expect(counting.get().measured).toBe(reported);
      expect(counting.latestMeasured()).toBe(reported);
    } finally {
      await live.dispose();
    }
  });

  it('pins the reported size at turn end when no measured anchor covers it', async () => {
    ctx.appendUserMessage([{ type: 'text', text: 'unmeasured tail' }]);
    const expected = tokenCounting.statusSize();
    expect(expected).toBeGreaterThan(0);
    expect(tokenCounting.latestMeasured()).toBe(0);

    await ctx.dispatcher.dispatch(
      new TurnEnded({ agentId: 'main', turnId: 1, reason: 'completed' }),
    );

    expect(tokenCounting.statusSize()).toBe(expected);
    expect(tokenCounting.latestMeasured()).toBe(0);
    const records = (await ctx.persistedWireRecords()).filter(
      (record) => record.type === 'token_counting.turn_recorded',
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ agentId: 'main', turnId: 1, length: 1, tokens: expected });
  });

  it('drops the pinned turn reading on compaction', async () => {
    ctx.appendUserMessage([{ type: 'text', text: 'unmeasured tail' }]);
    await ctx.dispatcher.dispatch(
      new TurnEnded({ agentId: 'main', turnId: 1, reason: 'completed' }),
    );
    expect(tokenCounting.statusSize()).toBeGreaterThan(0);

    void context.applyCompaction({
      summary: 'summary of the tail',
      compactedCount: 1,
      tokensBefore: 100,
      summaryOutputTokens: 50,
    });

    expect(tokenCounting.get().size).toBeGreaterThan(0);
    expect(tokenCounting.statusSize()).toBe(tokenCounting.get().size);
    expect(tokenCounting.latestMeasured()).toBe(0);
  });
});
