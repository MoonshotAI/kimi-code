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

describe('promptWithSkills', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  function agentWithSkills(): TestAgentContext {
    const catalog = new InMemorySkillCatalog();
    catalog.register(stubSkill('review', { content: '# Review body' }));
    catalog.register(stubSkill('security', { content: '# Security body' }));
    return createTestAgent(skillServices(catalog));
  }

  it('activates every skill and launches exactly one turn for the group', async () => {
    ctx = agentWithSkills();
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const launched = await ctx.rpc.promptWithSkills({
      input: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'review' }, { name: 'security' }],
      submissionId: 'submission-1',
    });
    expect(launched?.turn_id).toBe(0);
    await ctx.untilTurnEnd();

    // Both rendered skills precede the prompt in the single LLM call.
    expect(ctx.llmCalls).toHaveLength(1);
    const llmInput = JSON.stringify(ctx.llmInputs());
    expect(llmInput).toContain('# Review body');
    expect(llmInput).toContain('# Security body');
    expect(llmInput).toContain('Review this change.');

    // skill.activated fires per skill, tagged with the shared submission id,
    // before the single turn.started.
    const events = ctx.allEvents.filter(
      (event) =>
        event.type === '[rpc]' &&
        (event.event === 'skill.activated' || event.event === 'turn.started'),
    );
    expect(events.map((event) => event.event)).toEqual([
      'skill.activated',
      'skill.activated',
      'turn.started',
    ]);
    expect(
      events
        .slice(0, 2)
        .map((event) => (event.args as { readonly submissionId?: string }).submissionId),
    ).toEqual(['submission-1', 'submission-1']);
  });

  it('rejects the whole submission when any skill is unknown', async () => {
    ctx = agentWithSkills();

    await expect(
      ctx.rpc.promptWithSkills({
        input: [{ type: 'text', text: 'Review this change.' }],
        skills: [{ name: 'review' }, { name: 'missing' }],
      }),
    ).rejects.toThrow(/not found/i);

    expect(ctx.llmCalls).toHaveLength(0);
    expect(ctx.context.get()).toHaveLength(0);
    expect(
      ctx.allEvents.some((event) => event.type === '[rpc]' && event.event === 'skill.activated'),
    ).toBe(false);
  });

  it('undoes the prompt and its skill activations as one unit', async () => {
    ctx = agentWithSkills();
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.promptWithSkills({
      input: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'review' }, { name: 'security' }],
      submissionId: 'submission-1',
    });
    await ctx.untilTurnEnd();
    expect(ctx.context.get().length).toBeGreaterThan(0);

    const undone = await ctx.rpc.undoHistory({ count: 1 });
    expect(undone).toBe(1);
    expect(ctx.context.get()).toHaveLength(0);
  });
});
