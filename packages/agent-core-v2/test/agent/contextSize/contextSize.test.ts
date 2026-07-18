import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentContextMemoryService, IAgentProfileService } from '#/index';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { ContextSizeModel, contextSizeMeasured } from '#/agent/contextSize/contextSizeOps';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IWireService } from '#/wire/wire';

import { createTestAgent, type TestAgentContext } from '../../harness';

function totalOf(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  return usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation;
}

describe('Agent context size', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let contextSize: IAgentContextSizeService;
  let profile: IAgentProfileService;
  let usage: IAgentUsageService;
  let wire: IWireService;

  beforeEach(() => {
    ctx = createTestAgent();
    context = ctx.get(IAgentContextMemoryService);
    contextSize = ctx.get(IAgentContextSizeService);
    profile = ctx.get(IAgentProfileService);
    usage = ctx.get(IAgentUsageService);
    wire = ctx.get(IWireService);
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

    // The assistant message is folded into the context before the exchange
    // finishes, so the measured prefix must match the live history — an
    // inflated length silently knocks `get()` off the measured path onto the
    // per-message estimate branch (found as `tokenCount` reading ~50 while
    // the provider reported ~29k for a system-prompt-heavy "hi").
    expect(wire.getModel(ContextSizeModel)).toEqual({
      length: context.get().length,
      tokens: exchangeTotal,
    });

    const size = contextSize.get();
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

    expect(wire.getModel(ContextSizeModel)).toEqual({
      length: context.get().length,
      tokens: lastExchangeTotal,
    });
    expect(contextSize.get().measured).toBe(lastExchangeTotal);
    expect((await ctx.rpc.getContext({})).tokenCount).toBe(lastExchangeTotal);
  });

  it('estimates the not-yet-measured tail instead of dropping it', () => {
    ctx.appendUserMessage([{ type: 'text', text: 'hello world, not measured yet' }]);

    const size = contextSize.get();
    expect(size.measured).toBe(0);
    expect(size.estimated).toBeGreaterThan(0);
    expect(size.size).toBe(size.estimated);
  });

  it('tolerates a stored measured prefix longer than the live context', () => {
    ctx.appendUserMessage([{ type: 'text', text: 'only one message' }]);

    // A corrupt/overshooting record must not push reads onto the estimate
    // branch; the measured total is clamped to the live context instead.
    wire.dispatch(contextSizeMeasured({ length: 5, tokens: 1234 }));
    expect(contextSize.get().measured).toBe(1234);
  });
});
