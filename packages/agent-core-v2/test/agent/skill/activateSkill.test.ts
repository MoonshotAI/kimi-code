/**
 * Scenario: `IAgentSkillService.activate` is the wire-facing skill activation
 * entry — awaited, returning the launched turn id.
 *
 * The activation settles only once the turn has launched, and activation
 * failures (unknown skill, busy agent) surface to the caller instead of
 * fire-and-forget. Run: `pnpm --filter @moonshot-ai/agent-core-v2
 * exec vitest run test/agent/skill/activateSkill.test.ts`.
 *
 * Scenario: `IAgentSkillService.promptWithSkills` bundles one or more skill
 * activations into the prompt's own user message — the rendered skill blocks
 * precede the caller's parts in the content (one text part per skill, in
 * order) and every activation's metadata rides the prompt origin's
 * `skillActivations`. The bundle launches exactly one turn (one LLM call)
 * and undoes as a single anchor; `skill.activated` fires per skill before
 * `turn.started`. Unknown skill names, an empty skill list, and an empty
 * prompt each reject the whole submission with zero side effects (no LLM
 * call, no context, no events).
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
    expect(launched?.turn_id).toBe(0);

    await ctx.untilTurnEnd();
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

  it('bundles every skill into the prompt message and launches exactly one turn', async () => {
    ctx = agentWithSkills();
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const launched = await ctx.rpc.promptWithSkills({
      input: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'review' }, { name: 'security' }],
    });
    expect(launched?.turn_id).toBe(0);
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    const llmInput = JSON.stringify(ctx.llmInputs());
    expect(llmInput).toContain('# Review body');
    expect(llmInput).toContain('# Security body');
    expect(llmInput).toContain('Review this change.');

    const messages = ctx.context.get();
    const promptMessage = messages.find((message) => message.origin?.kind === 'user');
    expect(messages.filter((message) => message.origin?.kind === 'skill_activation')).toHaveLength(
      0,
    );
    expect(promptMessage?.origin).toMatchObject({
      kind: 'user',
      skillActivations: [{ skillName: 'review' }, { skillName: 'security' }],
    });
    const texts = promptMessage?.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text);
    expect(texts?.[0]).toContain('# Review body');
    expect(texts?.[1]).toContain('# Security body');
    expect(texts?.[2]).toContain('Review this change.');

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
        .map((event) => (event.args as { readonly skillName?: string }).skillName),
    ).toEqual(['review', 'security']);
    const started = events[2]?.args as { readonly prompt?: string };
    expect(started.prompt).toBe('Review this change.');
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

  it('rejects a grouped submission with an empty prompt message', async () => {
    ctx = agentWithSkills();

    await expect(
      ctx.rpc.promptWithSkills({
        input: [],
        skills: [{ name: 'review' }],
      }),
    ).rejects.toThrow(/non-empty prompt/i);

    expect(ctx.llmCalls).toHaveLength(0);
    expect(ctx.context.get()).toHaveLength(0);
    expect(
      ctx.allEvents.some((event) => event.type === '[rpc]' && event.event === 'skill.activated'),
    ).toBe(false);
  });

  it('rejects a grouped submission without any skills', async () => {
    ctx = agentWithSkills();

    await expect(
      ctx.rpc.promptWithSkills({
        input: [{ type: 'text', text: 'Review this change.' }],
        skills: [],
      }),
    ).rejects.toThrow(/at least one skill/i);

    expect(ctx.llmCalls).toHaveLength(0);
    expect(ctx.context.get()).toHaveLength(0);
    expect(
      ctx.allEvents.some((event) => event.type === '[rpc]' && event.event === 'skill.activated'),
    ).toBe(false);
  });

  it('undoes the bundled prompt as a single anchor', async () => {
    ctx = agentWithSkills();
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.promptWithSkills({
      input: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'review' }, { name: 'security' }],
    });
    await ctx.untilTurnEnd();
    expect(ctx.context.get().length).toBeGreaterThan(0);

    const undone = await ctx.rpc.undoHistory({ count: 1 });
    expect(undone).toBe(1);
    expect(ctx.context.get()).toHaveLength(0);
  });
});
