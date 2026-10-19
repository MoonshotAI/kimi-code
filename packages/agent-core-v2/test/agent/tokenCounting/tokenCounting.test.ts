import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentContextMemoryService, IAgentProfileService } from '#/index';
import { TurnEnded } from '#/agent/loop/turnOps';
import {
  anchorsEqual,
  normalizeAnchorLength,
  TokenCountingMeasured,
  TokenCountingRebased,
  TokenCountingTruncated,
  TokenCountingTurnRecorded,
  type TokenAnchor,
  type TokenCountingState,
} from '#/agent/tokenCounting/tokenCountingOps';
import { TokenCountingAgentModelDefinition } from '#/session/tokenCounting/tokenCountingAgentModel';
import { estimateTokensForMessages } from '#/llm-adapter/contract/tokens';
import type { TokenUsage } from '#human/llm/usage';
import { IWireService } from '#/wire/wire';

import { createTestAgent, InMemoryWireRecordPersistence, type TestAgentContext } from '../../harness';

function totalOf(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  return usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation;
}

function tokenCountingState(ctx: TestAgentContext) {
  return ctx.readModel(TokenCountingAgentModelDefinition, (model) => model._state());
}

type ReferenceEvent = {
  readonly kind: 'measured' | 'truncated' | 'rebased' | 'turn';
  readonly length: number;
  readonly tokens: number;
  readonly measured?: boolean;
};

function referenceFold(events: readonly ReferenceEvent[]): TokenCountingState {
  let anchors: readonly TokenAnchor[] = [];
  let tokens = 0;
  for (const event of events) {
    const length = normalizeAnchorLength(event.length);
    const clamped = Math.max(0, event.tokens);
    let next: readonly TokenAnchor[];
    switch (event.kind) {
      case 'measured':
        next = [
          ...anchors.filter((anchor) => anchor.length < length),
          { length, tokens: clamped, measured: true },
        ];
        break;
      case 'truncated':
        next = anchors.filter((anchor) => anchor.length <= length);
        break;
      case 'rebased':
        next = [{ length, tokens: clamped, measured: event.measured ?? false }];
        break;
      case 'turn':
        next = anchors.some((anchor) => anchor.length === length)
          ? anchors
          : [
            ...anchors.filter((anchor) => anchor.length < length),
            { length, tokens: clamped, measured: false },
          ];
        break;
    }
    if (!(tokens === clamped && anchorsEqual(anchors, next))) {
      anchors = next;
      tokens = clamped;
    }
  }
  return { anchors, tokens };
}

async function dispatchReference(ctx: TestAgentContext, event: ReferenceEvent): Promise<void> {
  switch (event.kind) {
    case 'measured':
      await ctx.dispatcher.dispatch(
        new TokenCountingMeasured({ agentId: 'main', length: event.length, tokens: event.tokens }),
      );
      return;
    case 'truncated':
      await ctx.dispatcher.dispatch(
        new TokenCountingTruncated({ agentId: 'main', length: event.length, tokens: event.tokens }),
      );
      return;
    case 'rebased':
      await ctx.dispatcher.dispatch(
        new TokenCountingRebased({
          agentId: 'main',
          length: event.length,
          tokens: event.tokens,
          measured: event.measured ?? false,
        }),
      );
      return;
    case 'turn':
      await ctx.dispatcher.dispatch(
        new TokenCountingTurnRecorded({
          agentId: 'main',
          turnId: 1,
          length: event.length,
          tokens: event.tokens,
        }),
      );
      return;
  }
}

describe('Agent token counting', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let tokenCounting: TestAgentContext['tokenCounting'];
  let profile: IAgentProfileService;
  let usage: TestAgentContext['usage'];

  beforeEach(async () => {
    ctx = createTestAgent();
    context = ctx.get(IAgentContextMemoryService);
    tokenCounting = ctx.tokenCounting;
    profile = ctx.get(IAgentProfileService);
    usage = ctx.usage;
    await ctx.restorePersisted();
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

    expect(tokenCountingState(ctx)).toEqual({
      anchors: [{ length: context.get().length, tokens: exchangeTotal, measured: true }],
      tokens: exchangeTotal,
    });

    const size = tokenCounting.get();
    expect(size.measured).toBe(exchangeTotal);
    expect(size.estimated).toBe(0);
    expect(size.size).toBe(exchangeTotal);
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

    expect(tokenCountingState(ctx).anchors).toHaveLength(2);
    expect(tokenCountingState(ctx).anchors[1]).toEqual({
      length: context.get().length,
      tokens: lastExchangeTotal,
      measured: true,
    });
    expect(tokenCounting.get().measured).toBe(lastExchangeTotal);
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

    context.applyCompaction({
      summary: 'summary of u1',
      compactedCount: 2,
      tokensBefore: 1_000,
      summaryOutputTokens: 500,
    });

    const history = context.get();
    const kept = estimateTokensForMessages(history.filter((m) => m.origin?.kind !== 'compaction_summary'));
    const expected = 500 + kept;
    expect(tokenCountingState(ctx).anchors).toEqual([
      { length: history.length, tokens: expected, measured: false },
    ]);
    expect(tokenCounting.get()).toEqual({ size: expected, measured: expected, estimated: 0 });
  });

  it('resets the ledger when the context is cleared', () => {
    ctx.appendAssistantTextWithUsage(1, 'answer', 1_000);
    expect(tokenCounting.get().measured).toBe(1_000);

    context.clear();

    expect(tokenCounting.get()).toEqual({ size: 0, measured: 0, estimated: 0 });
    expect(tokenCountingState(ctx).anchors).toEqual([
      { length: 0, tokens: 0, measured: true },
    ]);
  });

  it('keeps estimates and anchors live for internal reads under the measured strategy', () => {
    const measured = createTestAgent({ initialConfig: { tokenCounting: { strategy: 'measured' } } });
    try {
      const counting = measured.tokenCounting;
      expect(counting.strategy).toBe('measured');
      expect(counting.estimateText('abcd')).toBeGreaterThan(0);

      measured.appendUserMessage([{ type: 'text', text: 'hello world, not measured yet' }]);
      const tailEstimate = estimateTokensForMessages(
        measured.get(IAgentContextMemoryService).get(),
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
        expect(tokenCountingState(resumed)).toEqual(tokenCountingState(live));
        expect(resumedCounting.latestMeasured()).toBe(2_000);
        expect(resumedCounting.statusSize()).toBe(liveCounting.statusSize());
      } finally {
        await resumed.dispose();
      }
    } finally {
      await live.dispose();
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
      const estimate = estimateTokensForMessages(estimated.get(IAgentContextMemoryService).get());
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
      live.get(IAgentProfileService).update({ activeToolNames: [] });

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
        length: live.get(IAgentContextMemoryService).get().length,
        tokens: reported,
      });
      expect(tokenCountingState(live).anchors).toEqual([
        { length: 2, tokens: reported, measured: true },
      ]);
    } finally {
      await live.dispose();
    }
  });

  it('pins the reported size at turn end when no measured anchor covers it', async () => {
    ctx.appendUserMessage([{ type: 'text', text: 'unmeasured tail' }]);
    const expected = tokenCounting.statusSize();
    expect(expected).toBeGreaterThan(0);
    expect(tokenCountingState(ctx).anchors).toEqual([]);

    await ctx.dispatcher.dispatch(
      new TurnEnded({ agentId: 'main', turnId: 1, reason: 'completed' }),
    );

    expect(tokenCountingState(ctx).anchors).toEqual([
      { length: 1, tokens: expected, measured: false },
    ]);
    expect(tokenCounting.statusSize()).toBe(expected);
  });

  it('drops the pinned turn reading on compaction', async () => {
    ctx.appendUserMessage([{ type: 'text', text: 'unmeasured tail' }]);
    await ctx.dispatcher.dispatch(
      new TurnEnded({ agentId: 'main', turnId: 1, reason: 'completed' }),
    );
    expect(tokenCountingState(ctx).anchors).toHaveLength(1);

    context.applyCompaction({
      summary: 'summary of the tail',
      compactedCount: 1,
      tokensBefore: 100,
      summaryOutputTokens: 50,
    });

    const history = context.get();
    const anchors = tokenCountingState(ctx).anchors;
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toEqual({
      length: history.length,
      tokens: tokenCounting.get().size,
      measured: false,
    });
    expect(tokenCounting.statusSize()).toBe(tokenCounting.get().size);
  });

  it('dedups and replaces anchors by length across the four event kinds', async () => {
    await dispatchReference(ctx, { kind: 'measured', length: 2, tokens: 100 });
    await dispatchReference(ctx, { kind: 'measured', length: 4, tokens: 200 });
    expect(tokenCountingState(ctx)).toEqual({
      anchors: [
        { length: 2, tokens: 100, measured: true },
        { length: 4, tokens: 200, measured: true },
      ],
      tokens: 200,
    });

    await dispatchReference(ctx, { kind: 'turn', length: 6, tokens: 250 });
    expect(tokenCountingState(ctx)).toEqual({
      anchors: [
        { length: 2, tokens: 100, measured: true },
        { length: 4, tokens: 200, measured: true },
        { length: 6, tokens: 250, measured: false },
      ],
      tokens: 250,
    });

    const pinned = tokenCountingState(ctx);
    await dispatchReference(ctx, { kind: 'turn', length: 6, tokens: 250 });
    expect(tokenCountingState(ctx)).toBe(pinned);

    await dispatchReference(ctx, { kind: 'turn', length: 6, tokens: 260 });
    expect(tokenCountingState(ctx)).toEqual({
      anchors: [
        { length: 2, tokens: 100, measured: true },
        { length: 4, tokens: 200, measured: true },
        { length: 6, tokens: 250, measured: false },
      ],
      tokens: 260,
    });

    await dispatchReference(ctx, { kind: 'measured', length: 4, tokens: 300 });
    expect(tokenCountingState(ctx)).toEqual({
      anchors: [
        { length: 2, tokens: 100, measured: true },
        { length: 4, tokens: 300, measured: true },
      ],
      tokens: 300,
    });

    await dispatchReference(ctx, { kind: 'truncated', length: 3, tokens: 150 });
    expect(tokenCountingState(ctx)).toEqual({
      anchors: [{ length: 2, tokens: 100, measured: true }],
      tokens: 150,
    });

    const afterTruncate = tokenCountingState(ctx);
    await dispatchReference(ctx, { kind: 'truncated', length: 3, tokens: 150 });
    expect(tokenCountingState(ctx)).toBe(afterTruncate);

    await dispatchReference(ctx, { kind: 'rebased', length: 1, tokens: 50, measured: false });
    expect(tokenCountingState(ctx)).toEqual({
      anchors: [{ length: 1, tokens: 50, measured: false }],
      tokens: 50,
    });

    await dispatchReference(ctx, { kind: 'measured', length: 3.9, tokens: -10 });
    expect(tokenCountingState(ctx)).toEqual({
      anchors: [
        { length: 1, tokens: 50, measured: false },
        { length: 3, tokens: 0, measured: true },
      ],
      tokens: 0,
    });

    await dispatchReference(ctx, { kind: 'measured', length: -5, tokens: 10 });
    expect(tokenCountingState(ctx)).toEqual({
      anchors: [{ length: 0, tokens: 10, measured: true }],
      tokens: 10,
    });
  });

  it('grows the anchor ledger across many events matching a reference fold', async () => {
    const events: ReferenceEvent[] = [];
    for (let i = 1; i <= 240; i += 1) {
      events.push({ kind: 'measured', length: i, tokens: i * 10 });
      if (i % 5 === 0) events.push({ kind: 'turn', length: i, tokens: i * 10 });
      if (i % 10 === 0) events.push({ kind: 'turn', length: i, tokens: i * 10 + 1 });
      if (i % 50 === 0) {
        events.push({ kind: 'truncated', length: Math.floor(i / 2), tokens: i });
      }
    }

    for (const event of events) {
      await dispatchReference(ctx, event);
    }

    const state = tokenCountingState(ctx);
    expect(state).toEqual(referenceFold(events));
    expect(state.anchors[0]).toEqual({ length: 1, tokens: 10, measured: true });
    expect(state.anchors.at(-1)).toEqual({
      length: 240,
      tokens: 2_400,
      measured: true,
    });
    expect(state.anchors.length).toBeGreaterThan(50);
  });

  it('restores a large anchor ledger from the wire byte-for-byte', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const live = createTestAgent({ persistence });
    try {
      for (let i = 1; i <= 150; i += 1) {
        await live.dispatcher.dispatch(
          new TokenCountingMeasured({ agentId: 'main', length: i, tokens: i * 10 }),
        );
        if (i % 10 === 0) {
          await live.dispatcher.dispatch(
            new TokenCountingTurnRecorded({
              agentId: 'main',
              turnId: i,
              length: i,
              tokens: i * 10 + 1,
            }),
          );
        }
      }
      const liveState = tokenCountingState(live);
      expect(liveState.anchors).toHaveLength(150);
      const liveCounting = live.tokenCounting;
      await live.get(IWireService).flush();

      const resumed = createTestAgent({ persistence, autoConfigure: false });
      try {
        await resumed.restorePersisted();
        expect(tokenCountingState(resumed)).toEqual(liveState);
        expect(resumed.tokenCounting.latestMeasured()).toBe(liveCounting.latestMeasured());
        expect(resumed.tokenCounting.statusSize()).toBe(liveCounting.statusSize());
      } finally {
        await resumed.dispose();
      }
    } finally {
      await live.dispose();
    }
  });
});
