import { afterEach, describe, expect, it } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { InMemorySkillCatalog } from '#/features/skill/catalog/registry';

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

  function holdFirstStep(): { readonly started: Promise<void>; readonly release: () => void } {
    let releaseGate!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let armed = true;
    ctx.get(IAgentLoopService).hooks.onWillBeginStep.register(
      'test-hold-step',
      async (_hookCtx, next) => {
        if (armed) {
          armed = false;
          markStarted();
          await gate;
        }
        await next();
      },
    );
    return { started, release: releaseGate };
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

  it('steers the bundled submission into the running turn without starting a new one', async () => {
    ctx = agentWithSkills();
    ctx.mockNextResponse({ type: 'text', text: 'first reply' });
    ctx.mockNextResponse({ type: 'text', text: 'second reply' });
    const hold = holdFirstStep();

    const promptPromise = ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await hold.started;

    const steered = await ctx.rpc.promptWithSkills({
      input: [{ type: 'text', text: '/review src/app.ts' }],
      skills: [{ name: 'review', args: 'src/app.ts' }],
      steerIfActive: true,
    });
    expect(steered.turn_id).toBe(0);
    expect(steered.state).toBe('running');
    expect(steered.prompt_id).toBeTruthy();

    hold.release();
    await promptPromise;
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(2);
    const llmInput = JSON.stringify(ctx.llmInputs());
    expect(llmInput).toContain('# Review body');
    expect(llmInput).toContain('ARGUMENTS: src/app.ts');
    expect(llmInput).toContain('/review src/app.ts');

    const bundled = ctx.context
      .get()
      .find(
        (message) =>
          message.origin?.kind === 'user' && message.origin.skillActivations !== undefined,
      );
    expect(bundled?.origin).toMatchObject({
      kind: 'user',
      inTurn: true,
      skillActivations: [{ skillName: 'review', skillArgs: 'src/app.ts' }],
    });
    const texts = bundled?.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text);
    expect(texts?.[0]).toContain('# Review body');
    expect(texts?.[1]).toBe('/review src/app.ts');

    const events = ctx.allEvents.filter(
      (event) =>
        event.type === '[rpc]' &&
        (event.event === 'skill.activated' || event.event === 'turn.started'),
    );
    expect(events.map((event) => event.event)).toEqual(['turn.started', 'skill.activated']);
  });

  it.each([{ steerIfActive: undefined }, { steerIfActive: false }])(
    'queues the bundled submission behind the running turn with steerIfActive $steerIfActive',
    async ({ steerIfActive }) => {
      ctx = agentWithSkills();
      ctx.mockNextResponse({ type: 'text', text: 'first done' });
      ctx.mockNextResponse({ type: 'text', text: 'second done' });
      const hold = holdFirstStep();

      const promptPromise = ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
      await hold.started;

      const queued = await ctx.rpc.promptWithSkills({
        input: [{ type: 'text', text: '/review src/app.ts' }],
        skills: [{ name: 'review', args: 'src/app.ts' }],
        steerIfActive,
      });
      expect(queued.state).toBe('queued');
      expect(queued.turn_id).toBeUndefined();

      hold.release();
      await promptPromise;
      await ctx.untilTurnEnd();
      await ctx.untilTurnEnd();

      expect(ctx.llmCalls).toHaveLength(2);
      const firstInput = JSON.stringify(ctx.llmCalls[0]);
      expect(firstInput).toContain('start');
      expect(firstInput).not.toContain('# Review body');
      const secondInput = JSON.stringify(ctx.llmCalls[1]);
      expect(secondInput).toContain('# Review body');
      expect(secondInput).toContain('/review src/app.ts');

      const started = ctx.allEvents.filter(
        (event) => event.type === '[rpc]' && event.event === 'turn.started',
      );
      expect(started).toHaveLength(2);
    },
  );

  it('launches a new turn when idle even with the steer option', async () => {
    ctx = agentWithSkills();
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const launched = await ctx.rpc.promptWithSkills({
      input: [{ type: 'text', text: '/review src/app.ts' }],
      skills: [{ name: 'review', args: 'src/app.ts' }],
      steerIfActive: true,
    });
    expect(launched.turn_id).toBe(0);
    expect(launched.state).toBe('running');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    const llmInput = JSON.stringify(ctx.llmInputs());
    expect(llmInput).toContain('# Review body');
    expect(llmInput).toContain('ARGUMENTS: src/app.ts');
    expect(llmInput).toContain('/review src/app.ts');
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
