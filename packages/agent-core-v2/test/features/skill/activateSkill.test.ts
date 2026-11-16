import { afterEach, describe, expect, it } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { IEventBus } from '#/app/event/eventBus';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { PromptCompleted, PromptStarted, PromptSubmitted } from '#/agent/prompt/promptEvents';
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

  it('keeps the caller prompt id on the activation message', async () => {
    ctx = agentWithCommitSkill();
    ctx.mockNextResponse({ type: 'text', text: 'committed' });

    await ctx.rpc.activateSkill({ name: 'commit', promptId: 'msg_activation' });
    await ctx.untilTurnEnd();

    const activation = ctx.context.history().find((message) => message.origin?.kind === 'skill_activation');
    expect(activation?.id).toBe('msg_activation');
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

    const messages = ctx.context.history();
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

  it('uses the caller prompt id for the bundled submission', async () => {
    ctx = agentWithSkills();
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const launched = await ctx.rpc.promptWithSkills({
      input: [{ type: 'text', text: 'Review this change.' }],
      promptId: 'msg_bundled',
      skills: [{ name: 'review' }],
    });
    await ctx.untilTurnEnd();

    expect(launched.prompt_id).toBe('msg_bundled');
    expect(ctx.context.history().find((message) => message.origin?.kind === 'user')?.id).toBe('msg_bundled');
  });

  it('hands off a goal-originated active step to a bundled submission in a new turn', async () => {
    ctx = agentWithSkills();
    await ctx.restorePersisted();
    ctx.mockNextResponse({ type: 'text', text: 'second reply' });
    const loop = ctx.get(IAgentLoopService);
    const promptLifecycle: string[] = [];
    const eventBus = ctx.get(IEventBus);
    eventBus.subscribe(PromptSubmitted, (event) => promptLifecycle.push(`submitted:${event.promptId}`));
    eventBus.subscribe(PromptStarted, (event) => promptLifecycle.push(`started:${event.promptId}`));
    eventBus.subscribe(PromptCompleted, (event) => promptLifecycle.push(`completed:${event.promptId}`));
    const hold = holdFirstStep();
    const active = loop.submit({
      role: 'user',
      content: [{ type: 'text', text: 'goal continuation' }],
      attributes: {
        promptId: 'goal-continuation',
        origin: { kind: 'system_trigger', name: 'goal_continuation' } as PromptOrigin,
      },
    });
    const activeHandle = loop.promptHandle(active.id)!;
    await hold.started;
    expect(loop.snapshot()).toMatchObject({ activeTurnId: 0, activePromptId: active.id });

    const steeredPromise = ctx.rpc.promptWithSkills({
      input: [{ type: 'text', text: '/review src/app.ts' }],
      skills: [{ name: 'review', args: 'src/app.ts' }],
      steerIfActive: true,
    });
    hold.release();
    const steered = await steeredPromise;
    expect(steered.turn_id).toBe(1);
    expect(steered.state).toBe('running');
    expect(steered.steered).toBe(true);
    expect(steered.prompt_id).toBeTruthy();

    await expect(activeHandle.completion).resolves.toMatchObject({ state: 'completed' });
    await loop.settled();

    expect(ctx.llmCalls).toHaveLength(1);
    const llmInput = JSON.stringify(ctx.llmInputs());
    expect(llmInput).toContain('# Review body');
    expect(llmInput).toContain('ARGUMENTS: src/app.ts');
    expect(llmInput).toContain('/review src/app.ts');

    const bundled = ctx.context
      .history()
      .find(
        (message) =>
          message.origin?.kind === 'user' && message.origin.skillActivations !== undefined,
      );
    expect(bundled?.origin).toMatchObject({
      kind: 'user',
      skillActivations: [{ skillName: 'review', skillArgs: 'src/app.ts' }],
    });
    const texts = bundled?.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text);
    expect(texts?.[0]).toContain('# Review body');
    expect(texts?.[1]).toBe('/review src/app.ts');
    expect(promptLifecycle.filter((entry) => entry.endsWith(`:${active.id}`))).toEqual([
      `submitted:${active.id}`,
      `started:${active.id}`,
      `completed:${active.id}`,
    ]);

    const events = ctx.allEvents.filter(
      (event) =>
        event.type === '[rpc]' &&
        (event.event === 'skill.activated' || event.event === 'turn.started'),
    );
    expect(events.map((event) => event.event)).toEqual(['turn.started', 'skill.activated', 'turn.started']);
  });

  it('clears a previous parent workspace when a multi-skill bundle steers into the turn', async () => {
    const parentA = stubSkill('parent', { path: '/work/A/parent/SKILL.md', dir: '/work/A/parent', content: 'parent from A', workspaceDir: '/work/A' });
    const parentB = stubSkill('parent', { path: '/work/B/parent/SKILL.md', dir: '/work/B/parent', content: 'parent from B', workspaceDir: '/work/B' });
    const childA = stubSkill('child', { path: '/work/A/child/SKILL.md', dir: '/work/A/child', content: 'child from A', workspaceDir: '/work/A' });
    const childB = stubSkill('child', { path: '/work/B/child/SKILL.md', dir: '/work/B/child', content: 'child from B', workspaceDir: '/work/B' });
    const catalog = new InMemorySkillCatalog();
    catalog.register(parentA);
    catalog.register(childA);
    catalog.register(stubSkill('other'));
    catalog.registerVariants([parentA, parentB, childA, childB, stubSkill('other')], { replace: true });
    ctx = createTestAgent(skillServices(catalog));
    ctx.mockNextResponse({ type: 'text', text: 'Load child.' }, {
      type: 'function',
      id: 'call_child',
      name: 'Skill',
      arguments: '{"skill":"child"}',
    });
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    const hold = holdFirstStep();
    const promptPromise = ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await hold.started;
    const parentSteer = ctx.rpc.promptWithSkills({
      input: [{ type: 'text', text: 'Use parent B' }],
      skills: [{ name: 'parent', path: parentB.path }],
      steerIfActive: true,
    });
    const multipleSteer = ctx.rpc.promptWithSkills({
      input: [{ type: 'text', text: 'Use multiple skills' }],
      skills: [{ name: 'parent', path: parentB.path }, { name: 'other' }],
      steerIfActive: true,
    });
    hold.release();
    await parentSteer;
    const steered = await multipleSteer;
    expect(steered.steered).toBe(true);
    await promptPromise;
    await ctx.get(IAgentLoopService).settled();

    const nested = ctx.context.history().filter((message) =>
      message.origin?.kind === 'skill_activation' && message.origin.skillName === 'child'
    );
    expect(nested).toHaveLength(1);
    expect(JSON.stringify(nested[0])).toContain('child from A');
    expect(JSON.stringify(nested[0])).toContain('/work/A/child/SKILL.md');
    expect(JSON.stringify(nested[0])).toContain('model-tool');
    expect(JSON.stringify(nested[0])).not.toContain('nested-skill');
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
      expect(queued.steered).toBe(false);
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

  it('keeps the bundled parent workspace when a queued submission launches', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.registerVariants([
      { ...stubSkill('parent'), path: '/work/A/parent/SKILL.md', dir: '/work/A/parent', content: 'parent from A', workspaceDir: '/work/A' },
      { ...stubSkill('parent'), path: '/work/B/parent/SKILL.md', dir: '/work/B/parent', content: 'parent from B', workspaceDir: '/work/B' },
      { ...stubSkill('child'), path: '/work/A/child/SKILL.md', dir: '/work/A/child', content: 'child from A', workspaceDir: '/work/A' },
      { ...stubSkill('child'), path: '/work/B/child/SKILL.md', dir: '/work/B/child', content: 'child from B', workspaceDir: '/work/B' },
    ], { replace: true });
    ctx = createTestAgent(skillServices(catalog));
    ctx.mockNextResponse({ type: 'text', text: 'first done' });
    ctx.mockNextResponse({ type: 'text', text: 'Load child.' }, {
      type: 'function',
      id: 'call_child',
      name: 'Skill',
      arguments: '{"skill":"child"}',
    });
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    const hold = holdFirstStep();
    const promptPromise = ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await hold.started;

    const queued = await ctx.rpc.promptWithSkills({
      input: [{ type: 'text', text: 'Use the parent skill' }],
      skills: [{ name: 'parent', path: '/work/B/parent/SKILL.md' }],
    });
    expect(queued.state).toBe('queued');

    hold.release();
    await promptPromise;
    await ctx.untilTurnEnd();
    await ctx.untilTurnEnd();

    const nested = ctx.context.history().filter((message) =>
      message.origin?.kind === 'skill_activation' && message.origin.skillName === 'child'
    );
    expect(nested).toHaveLength(1);
    expect(JSON.stringify(nested[0])).toContain('child from B');
    expect(JSON.stringify(nested[0])).toContain('/work/B/child/SKILL.md');
    expect(JSON.stringify(nested[0])).toContain('nested-skill');
    expect(JSON.stringify(nested[0])).not.toContain('child from A');
  });

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
    expect(ctx.context.history()).toHaveLength(0);
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
    expect(ctx.context.history()).toHaveLength(0);
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
    expect(ctx.context.history()).toHaveLength(0);
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
    expect(ctx.context.history().length).toBeGreaterThan(0);

    const undone = await ctx.rpc.undoHistory({ count: 1 });
    expect(undone).toBe(1);
    expect(ctx.context.history()).toHaveLength(0);
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
