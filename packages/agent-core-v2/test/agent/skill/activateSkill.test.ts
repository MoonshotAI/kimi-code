/**
 * Scenario: `IAgentSkillService.activate` is the wire-facing skill activation
 * entry — awaited, returning the launched turn id.
 *
 * The activation settles only once the turn has launched, and activation
 * failures (unknown skill, busy agent) surface to the caller instead of
 * fire-and-forget. Run: `pnpm --filter @moonshot-ai/agent-core-v2
 * exec vitest run test/agent/skill/activateSkill.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';

import { stubSkill } from '../../app/skillCatalog/stubs';
import { createTestAgent, skillServices, type TestAgentContext } from '../../harness';

describe('activateSkill', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  function agentWithCommitSkill(): TestAgentContext {
    const catalog = new InMemorySkillCatalog();
    catalog.register(stubSkill('commit', { content: '# Commit body' }));
    return createTestAgent(skillServices(catalog));
  }

  it('launches a turn with the rendered skill prompt and returns its id', async () => {
    ctx = agentWithCommitSkill();
    ctx.mockNextResponse({ type: 'text', text: 'committed' });

    const launched = await ctx.rpc.activateSkill({ name: 'commit', args: '-m fix' });
    // Turn ids are 0-based; the point is the launch result came back at all.
    expect(launched?.turn_id).toBe(0);

    await ctx.untilTurnEnd();
    // JSON.stringify escapes the block's attribute quotes — assert on the
    // quote-free fragments.
    const llmInput = JSON.stringify(ctx.llmInputs());
    expect(llmInput).toContain('skill-loaded');
    expect(llmInput).toContain('# Commit body');
    expect(llmInput).toContain('ARGUMENTS: -m fix');
  });

  it('rejects for an unknown skill instead of failing silently', async () => {
    ctx = agentWithCommitSkill();

    await expect(ctx.rpc.activateSkill({ name: 'missing' })).rejects.toThrow(/not found/i);
  });
});
