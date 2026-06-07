import { describe, expect, it } from 'vitest';

import type { KimiConfig } from '../../src/config';
import { estimateTokens, estimateTokensForTools } from '../../src/utils/tokens';
import { testAgent, type AgentTestContext } from './harness/agent';

interface StatusArgs {
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly contextUsage?: number;
}

function readStatus(ctx: AgentTestContext): StatusArgs {
  ctx.agent.emitStatusUpdated();
  const statuses = ctx.allEvents.filter(
    (entry) => entry.type === '[rpc]' && entry.event === 'agent.status.updated',
  );
  const last = statuses.at(-1);
  if (last === undefined) throw new Error('expected an agent.status.updated event');
  return (last as unknown as { readonly args: StatusArgs }).args;
}

function baselineTokens(ctx: AgentTestContext): number {
  return (
    estimateTokens(ctx.agent.config.systemPrompt) +
    estimateTokensForTools(ctx.agent.tools.loopTools)
  );
}

function configWithMode(mode: 'include' | 'subtract'): KimiConfig {
  return { providers: {}, contextWindow: { baselineMode: mode } };
}

describe('emitStatusUpdated baseline accounting', () => {
  it('reports zero on a fresh session by default (off)', () => {
    const ctx = testAgent();
    ctx.configure();

    expect(readStatus(ctx).contextTokens).toBe(0);
  });

  it('folds the baseline into the count on a fresh session when include is set', () => {
    const ctx = testAgent({ initialConfig: configWithMode('include') });
    ctx.configure();

    const status = readStatus(ctx);
    expect(status.contextTokens).toBe(baselineTokens(ctx));
    expect(status.contextTokens).toBeGreaterThan(0);
  });

  it('does not double-count the baseline once the real provider total arrives', () => {
    const ctx = testAgent({ initialConfig: configWithMode('include') });
    ctx.configure();
    // The provider input count already includes the baseline; with max() the
    // real total wins instead of being added on top of the baseline again.
    ctx.appendAssistantTextWithUsage(1, 'answer', 5_000);

    expect(baselineTokens(ctx)).toBeLessThan(5_000);
    expect(readStatus(ctx).contextTokens).toBe(5_000);
  });

  it('reserves the baseline out of the usable window when subtract is set', () => {
    const ctx = testAgent({ initialConfig: configWithMode('subtract') });
    ctx.configure();

    const status = readStatus(ctx);
    const window = ctx.agent.config.modelCapabilities.max_context_tokens ?? 0;
    expect(status.maxContextTokens).toBe(window - baselineTokens(ctx));
    expect(status.contextTokens).toBe(0);
  });
});
