import { afterEach, describe, expect, it } from 'vitest';

import { InMemorySkillCatalog } from '#/features/skill/catalog/registry';
import { IAgentLoopService } from '#/agent/loop/loop';

import { stubSkill } from './catalog/stubs';
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
    expect(launched.turn_id).toBe(0);
    expect(launched.prompt_id).toBeTruthy();
    expect(launched.state).toBe('running');
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

  it('steers a bundled skill message into the running turn with its arguments', async () => {
    ctx = agentWithSkills();
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    ctx.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-for-skill-steer', async (_context, next) => {
      markStarted();
      await gate;
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'starting' });
    ctx.mockNextResponse({ type: 'text', text: 'reviewed' });

    const first = ctx.rpc.prompt({ input: [{ type: 'text', text: 'Start the review.' }] });
    await started;
    await first;
    const steered = await ctx.rpc.promptWithSkills({
      input: [{ type: 'text', text: '/review focus on auth' }],
      skills: [{ name: 'review', args: 'focus on auth' }],
      steerIfActive: true,
    });
    expect(steered.state).toBe('running');
    expect(steered.turn_id).toBeDefined();
    release();
    await ctx.untilTurnEnd();

    expect(ctx.allEvents.filter((event) => event.type === '[rpc]' && event.event === 'turn.started')).toHaveLength(1);
    const bundled = ctx.context.get().find((message) => message.origin?.kind === 'user' && message.origin.skillActivations !== undefined);
    expect(bundled?.origin).toMatchObject({
      kind: 'user',
      skillActivations: [{ skillName: 'review', skillArgs: 'focus on auth' }],
    });
    expect(bundled?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('# Review body') });
    expect(bundled?.content).toContainEqual({ type: 'text', text: '/review focus on auth' });
    const llmInput = JSON.stringify(ctx.llmInputs());
    expect(llmInput).toContain('ARGUMENTS: focus on auth');
    expect(llmInput).toContain('/review focus on auth');
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
    await ctx.restorePersisted();
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

  it('accepts later prompt_id reuse of a bundled prompt id as a pure correlation id', async () => {
    ctx = agentWithSkills();
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    const launched = await ctx.rpc.promptWithSkills({
      input: [{ type: 'text', text: 'Review this change.' }],
      skills: [{ name: 'review' }],
    });
    await ctx.untilTurnEnd();

    ctx.mockNextResponse({ type: 'text', text: 'again done' });
    const reused = await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'again' }],
      promptId: launched.prompt_id,
    });
    expect(reused).toEqual({ turn_id: 1 });
    await ctx.untilTurnEnd();
  });
});
