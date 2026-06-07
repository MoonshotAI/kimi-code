import { describe, expect, it } from 'vitest';

import { computeContextBreakdown } from '../../src/agent/context/breakdown';
import type { ContextCategoryKey } from '../../src/agent/context/breakdown';
import { estimateTokens, estimateTokensForTools } from '../../src/utils/tokens';
import { testAgent } from './harness/agent';

const EXPECTED_ORDER: readonly ContextCategoryKey[] = [
  'systemPrompt',
  'systemTools',
  'mcpTools',
  'customAgents',
  'memoryFiles',
  'skills',
  'messages',
  'freeSpace',
];

describe('computeContextBreakdown', () => {
  it('reports every category in a stable order whose non-free tokens sum to the total', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Read', 'Write'] });

    const breakdown = await computeContextBreakdown(ctx.agent);

    expect(breakdown.categories.map((cat) => cat.key)).toEqual(EXPECTED_ORDER);

    const nonFree = breakdown.categories
      .filter((cat) => cat.key !== 'freeSpace')
      .reduce((sum, cat) => sum + cat.tokens, 0);
    expect(nonFree).toBe(breakdown.totalTokens);
    for (const cat of breakdown.categories) {
      expect(cat.tokens).toBeGreaterThanOrEqual(0);
    }
  });

  it('derives free space as the unused remainder of the context window', async () => {
    const ctx = testAgent();
    ctx.configure();

    const breakdown = await computeContextBreakdown(ctx.agent);

    expect(breakdown.maxContextTokens).toBeGreaterThan(0);
    const free = breakdown.categories.find((cat) => cat.key === 'freeSpace');
    expect(free?.tokens).toBe(breakdown.maxContextTokens - breakdown.totalTokens);
  });

  it('subtracts the embedded skills + memory estimate from the system-prompt bucket', async () => {
    const ctx = testAgent();
    ctx.configure();

    const breakdown = await computeContextBreakdown(ctx.agent);
    const get = (key: ContextCategoryKey): number =>
      breakdown.categories.find((cat) => cat.key === key)?.tokens ?? 0;

    const fullSystemPrompt = estimateTokens(ctx.agent.config.systemPrompt);
    const expectedBase = Math.max(0, fullSystemPrompt - get('skills') - get('memoryFiles'));
    expect(get('systemPrompt')).toBe(expectedBase);
  });

  it('counts active built-in tools and leaves custom agents empty when none are exposed', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Read', 'Write'] });

    const breakdown = await computeContextBreakdown(ctx.agent);
    const get = (key: ContextCategoryKey): number =>
      breakdown.categories.find((cat) => cat.key === key)?.tokens ?? 0;

    expect(get('systemTools')).toBe(estimateTokensForTools(ctx.agent.tools.loopTools));
    expect(get('mcpTools')).toBe(0);
    expect(get('customAgents')).toBe(0);
  });

  it('anchors the total to the real provider count after a turn so it matches the footer', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Read', 'Write'] });
    // The provider reports a real input total that exceeds the character
    // estimate; the breakdown total should equal it (not the estimate) so the
    // headline percentage matches the status-bar indicator.
    ctx.appendAssistantTextWithUsage(1, 'answer', 50_000);

    const breakdown = await computeContextBreakdown(ctx.agent);
    const get = (key: ContextCategoryKey): number =>
      breakdown.categories.find((cat) => cat.key === key)?.tokens ?? 0;

    expect(breakdown.totalTokens).toBe(ctx.agent.context.tokenCount);
    expect(breakdown.totalTokens).toBe(50_000);
    const fixed = breakdown.categories
      .filter((cat) => cat.key !== 'messages' && cat.key !== 'freeSpace')
      .reduce((sum, cat) => sum + cat.tokens, 0);
    expect(get('messages')).toBe(50_000 - fixed);
  });
});
