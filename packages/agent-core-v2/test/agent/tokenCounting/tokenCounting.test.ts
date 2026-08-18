import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentContextMemoryService, IAgentProfileService } from '#/index';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { TokenCountingMeasured, tokenCountingKey } from '#/agent/tokenCounting/tokenCountingOps';
import { IEventBus } from '#/app/event/eventBus';
import type { Message } from '#/kosong/contract/message';
import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import type { TokenUsage } from '#/kosong/contract/usage';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IWireService } from '#/wire/wire';

import { createTestAgent, InMemoryWireRecordPersistence, type TestAgentContext } from '../../harness';

function totalOf(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  return usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation;
}

describe('Agent token counting', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let tokenCounting: IAgentTokenCountingService;
  let profile: IAgentProfileService;
  let usage: IAgentUsageService;

  beforeEach(() => {
    ctx = createTestAgent();
    context = ctx.get(IAgentContextMemoryService);
    tokenCounting = ctx.get(IAgentTokenCountingService);
    profile = ctx.get(IAgentProfileService);
    usage = ctx.get(IAgentUsageService);
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

    expect(ctx.agentState.get(tokenCountingKey)).toEqual({
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

    expect(ctx.agentState.get(tokenCountingKey).anchors).toHaveLength(2);
    expect(ctx.agentState.get(tokenCountingKey).anchors[1]).toEqual({
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

    await ctx.dispatcher.dispatch(new TokenCountingMeasured({ length: 5, tokens: 1234 }));
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
    const kept = estimateTokensForMessages(history.filter((m) => m.origin?.kind === 'user'));
    const expected = 500 + kept;
    expect(ctx.agentState.get(tokenCountingKey).anchors).toEqual([
      { length: history.length, tokens: expected, measured: false },
    ]);
    expect(tokenCounting.get()).toEqual({ size: expected, measured: expected, estimated: 0 });
  });

  it('resets the ledger when the context is cleared', () => {
    ctx.appendAssistantTextWithUsage(1, 'answer', 1_000);
    expect(tokenCounting.get().measured).toBe(1_000);

    context.clear();

    expect(tokenCounting.get()).toEqual({ size: 0, measured: 0, estimated: 0 });
    expect(ctx.agentState.get(tokenCountingKey).anchors).toEqual([
      { length: 0, tokens: 0, measured: true },
    ]);
  });

  it('keeps estimates and anchors live for internal reads under the measured strategy', () => {
    const measured = createTestAgent({ initialConfig: { tokenCounting: { strategy: 'measured' } } });
    try {
      const counting = measured.get(IAgentTokenCountingService);
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
      const counting = estimated.get(IAgentTokenCountingService);
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
      const liveCounting = live.get(IAgentTokenCountingService);
      expect(liveCounting.statusSize()).toBe(2_000);
      await live.get(IWireService).flush();

      expect(persistence.records.map((record) => record.type)).toContain('token_counting.measured');

      const resumed = createTestAgent({ persistence, autoConfigure: false });
      try {
        await resumed.restorePersisted();
        const resumedCounting = resumed.get(IAgentTokenCountingService);
        expect(resumed.get(IAgentStateService).get(tokenCountingKey)).toEqual(
          live.get(IAgentStateService).get(tokenCountingKey),
        );
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
      const counting = measured.get(IAgentTokenCountingService);
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
      const counting = estimated.get(IAgentTokenCountingService);
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

  it('keeps the measured prefix aligned with settled storage across a streamed step', () => {
    // The loop opens a partial assistant at `step.begin` and settles it with
    // the response content after the request returns, so the live input array
    // already includes the fold-opened assistant when `measured()` runs.
    // Counting the folded output again would park the measured prefix one past
    // the stored context: the whole-context read would fall off the exact
    // measured aggregate onto a per-message estimate until the next append
    // caught the length up, and the footer gauge would swing between estimate
    // and request caliber at every turn boundary.
    ctx.appendUserMessage([{ type: 'text', text: 'hello world '.repeat(20) }]);
    context.appendLoopEvent({ type: 'step.begin', uuid: 'step-1' });

    const tokenUsage: TokenUsage = {
      inputCacheRead: 0,
      inputCacheCreation: 0,
      inputOther: 20_000,
      output: 500,
    };
    const response: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'answer '.repeat(40) }],
      toolCalls: [],
    };
    // Mirrors the llmRequester call site: `input` is the live request array
    // (already holding the fold-opened assistant), `output` is informational.
    tokenCounting.measured(context.get(), [response], tokenUsage);
    context.appendLoopEvent({
      type: 'content.part',
      stepUuid: 'step-1',
      part: { type: 'text', text: 'answer '.repeat(40) },
    });
    context.appendLoopEvent({ type: 'step.end', uuid: 'step-1' });

    // Settled storage = user + assistant, exactly covered by the measured
    // prefix: the whole-context read is the LLM-reported total with no
    // estimate tail.
    expect(context.get()).toHaveLength(2);
    expect(tokenCounting.get()).toEqual({ size: 20_500, measured: 20_500, estimated: 0 });

    // The next user message lands on the measured aggregate as a small tail
    // estimate instead of re-deriving the whole context from estimates.
    ctx.appendUserMessage([{ type: 'text', text: 'next question' }]);
    const after = tokenCounting.get();
    expect(after.measured).toBe(20_500);
    expect(after.estimated).toBeGreaterThan(0);
    expect(after.size).toBe(after.measured + after.estimated);
  });

  describe('raw size gauge', () => {
    let projector: IAgentContextProjectorService;
    let raws: number[];

    /** The unfolded-request cost the status line should show, computed independently. */
    const expectedRaw = (): number => {
      const history = context.get();
      const rawMessages = estimateTokensForMessages(history);
      const projectedMessages = estimateTokensForMessages(projector.project(history));
      return tokenCounting.get().size + Math.max(0, rawMessages - projectedMessages);
    };

    beforeEach(() => {
      projector = ctx.get(IAgentContextProjectorService);
      raws = [];
      ctx.get(IEventBus).subscribe((event) => {
        const e = event as { type?: string; rawContextTokens?: number };
        if (e.type === 'agent.status.updated' && e.rawContextTokens !== undefined) {
          raws.push(e.rawContextTokens);
        }
      });
    });

    it('publishes the raw (unfolded) cost on every context mutation', () => {
      ctx.appendUserMessage([{ type: 'text', text: 'hello world '.repeat(50) }]);
      expect(raws.at(-1)).toBe(expectedRaw());

      // A streamed step folds content into the open assistant AFTER its
      // request returned; the raw gauge must follow the context, not the
      // measured cadence.
      context.append({
        role: 'assistant',
        content: [{ type: 'text', text: 'working on it '.repeat(40) }],
        toolCalls: [],
      });
      expect(raws.at(-1)).toBe(expectedRaw());
      expect(raws.at(-1)).toBeGreaterThan(raws.at(-2) as number);
    });

    it('keeps raw >= projected size and consistent with rawSize()', () => {
      ctx.appendUserMessage([{ type: 'text', text: 'something' }]);
      for (const raw of raws) {
        expect(raw).toBeGreaterThanOrEqual(tokenCounting.get().size);
      }
      expect(tokenCounting.rawSize()).toBe(raws.at(-1));
    });

    it('tracks shrinking histories (clear)', () => {
      ctx.appendUserMessage([{ type: 'text', text: 'something' }]);
      expect(raws.at(-1)).toBeGreaterThan(0);

      context.clear();
      expect(raws.at(-1)).toBe(0);
      expect(tokenCounting.rawSize()).toBe(0);
    });
  });
});
