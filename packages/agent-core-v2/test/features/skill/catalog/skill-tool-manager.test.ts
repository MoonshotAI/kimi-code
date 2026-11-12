import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { ToolCall } from '#human/message';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { IEventBus } from '#/app/event/eventBus';
import { InMemorySkillCatalog } from '#/features/skill/catalog/registry';
import { executeModelSkill } from '#/features/skill/tools/skillTool';
import { type SkillCatalog, type SkillDefinition } from '#/features/skill/catalog/types';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import {
  InMemoryWireRecordPersistence,
  createTestAgent,
  skillServices,
  telemetryServices,
  wireRecordPersistenceServices,
  type TestAgentContext,
} from '../../../harness';
import { recordingTelemetry } from '../../../app/telemetry/stubs';
import { stubToolResultTruncationService } from '../../../agent/toolResultTruncation/stubs';
import { stubSkill } from './stubs';

function makeSkill(name: string, metadata: SkillDefinition['metadata'] = {}): SkillDefinition {
  return stubSkill(name, { metadata });
}

function recordContainsSkillLoaded(record: unknown, skillName: string): boolean {
  if (!isRecordWithMessage(record)) return false;
  return (
    record.message.content?.some((part) => {
      return (
        part.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.includes(`<skill-loaded name="${skillName}"`)
      );
    }) ?? false
  );
}

function isRecordWithMessage(
  record: unknown,
): record is {
  readonly type: string;
  readonly message: {
    readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  };
} {
  if (record === null || typeof record !== 'object') return false;
  const candidate = record as { readonly type?: unknown; readonly message?: unknown };
  return (
    candidate.type === 'context.append_message' &&
    candidate.message !== null &&
    typeof candidate.message === 'object'
  );
}

describe('ToolManager SkillTool registration', () => {
  let ctx: TestAgentContext;
  let profile: IAgentLoopService;
  let tools: IAgentToolRegistryService;

  beforeEach(() => {
    ctx = createTestAgent();
    profile = ctx.get(IAgentLoopService);
    tools = ctx.get(IAgentToolRegistryService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('exposes Skill even when the agent has no registered skills', () => {
    profile.update({ activeToolNames: ['Skill'] });

    expect(ctx.toolsData().find((tool) => tool.name === 'Skill')).toMatchObject({
      name: 'Skill',
    });
    expect(tools.resolve('Skill')).toMatchObject({ name: 'Skill' });
  });
});

describe('ToolManager SkillTool registration with an empty model skill catalog', () => {
  let ctx: TestAgentContext;
  let profile: IAgentLoopService;
  let tools: IAgentToolRegistryService;
  let skills: InMemorySkillCatalog;

  beforeEach(() => {
    skills = new InMemorySkillCatalog();
    skills.register(makeSkill('private', { disableModelInvocation: true }));
    ctx = createTestAgent(skillServices(skills));
    profile = ctx.get(IAgentLoopService);
    tools = ctx.get(IAgentToolRegistryService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('exposes Skill even when there are no model-invocable skills', () => {
    profile.update({ activeToolNames: ['Skill'] });

    expect(ctx.toolsData().find((tool) => tool.name === 'Skill')).toMatchObject({
      name: 'Skill',
    });
    expect(tools.resolve('Skill')).toMatchObject({ name: 'Skill' });
  });
});

describe('ToolManager SkillTool registration with inline skills', () => {
  let ctx: TestAgentContext;
  let profile: IAgentLoopService;
  let tools: IAgentToolRegistryService;
  let skills: InMemorySkillCatalog;

  beforeEach(() => {
    skills = new InMemorySkillCatalog();
    skills.register(makeSkill('review'));
    skills.register(makeSkill('flow-only', { type: 'flow' }));
    ctx = createTestAgent(skillServices(skills));
    profile = ctx.get(IAgentLoopService);
    tools = ctx.get(IAgentToolRegistryService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('exposes Skill when at least one inline skill is model-invocable', () => {
    profile.update({ activeToolNames: ['Skill'] });

    const skillInfo = ctx.toolsData().find((tool) => tool.name === 'Skill');
    const skillTool = tools.resolve('Skill');

    expect(skillInfo).toMatchObject({ name: 'Skill', active: true, source: 'builtin' });
    expect(skillTool).toMatchObject({
      name: 'Skill',
      description: expect.stringContaining('Invoke a registered skill'),
    });
  });
});

describe('ToolManager SkillTool registration with a structural catalog', () => {
  let ctx: TestAgentContext;
  let profile: IAgentLoopService;
  let tools: IAgentToolRegistryService;
  let skills: SkillCatalog;

  beforeEach(() => {
    const skill = makeSkill('review');
    skills = {
      getSkill: (name) => (name === skill.name ? skill : undefined),
      getPluginSkill: () => undefined,
      renderSkillPrompt: () => skill.content,
      listDefaultSkills: () => [skill],
      listSkills: () => [skill],
      listInvocableSkills: () => [skill],
      registerVariants: () => {},
      getSkillRoots: () => ['/skills/review'],
      getSkippedByPolicy: () => [],
      getModelSkillListing: () => '- review: desc for review',
    };
    ctx = createTestAgent(skillServices(skills));
    profile = ctx.get(IAgentLoopService);
    tools = ctx.get(IAgentToolRegistryService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('accepts a structural skill registry implementation', () => {
    profile.update({ activeToolNames: ['Skill'] });

    expect(skills.getSkillRoots()).toEqual(['/skills/review']);
    expect(tools.resolve('Skill')).toMatchObject({ name: 'Skill' });
  });
});

describe('SkillTool nested variants', () => {
  it('prefers a nested skill from the parent workspace directory', async () => {
    const catalog = new InMemorySkillCatalog();
    catalog.registerVariants([
      {
        ...makeSkill('parent.child'),
        path: '/work/A/parent/child/SKILL.md',
        dir: '/work/A/parent/child',
        content: 'from A',
        workspaceDir: '/work/A',
      },
      {
        ...makeSkill('parent.child'),
        path: '/work/B/parent/child/SKILL.md',
        dir: '/work/B/parent/child',
        content: 'from B',
        workspaceDir: '/work/B',
      },
    ], { replace: true });
    const sessionCatalog: Parameters<typeof executeModelSkill>[0] = {
      _serviceBrand: undefined,
      catalog,
      ready: Promise.resolve(),
      onDidChange: () => ({ dispose: () => {} }),
      load: async () => {},
      reload: async () => {},
      list: async () => [],
    };
    const skillService: Parameters<typeof executeModelSkill>[1] = {
      _serviceBrand: undefined,
      activate: vi.fn(),
      promptWithSkills: vi.fn(),
      recordModelToolActivation: vi.fn(),
      modelToolContext: () => ({ queryDepth: 0 }),
    };

    const reminders: unknown[] = [];
    await executeModelSkill(
      sessionCatalog,
      skillService,
      { remind: (...entries: unknown[]) => reminders.push(...entries) } as unknown as IAgentLoopService,
      stubToolResultTruncationService(),
      { skill: 'parent.child' },
      1,
      'session-1',
      'call_skill',
      '/work/B',
    );

    expect(JSON.stringify(reminders)).toContain('from B');
    expect(JSON.stringify(reminders)).toContain('/work/B/parent/child/SKILL.md');
  });
});

describe('ToolManager SkillTool wire behavior', () => {
  let ctx: TestAgentContext;
  let context: IAgentLoopService;
  let profile: IAgentLoopService;
  let persistence: InMemoryWireRecordPersistence;
  let skills: InMemorySkillCatalog;

  beforeEach(() => {
    skills = new InMemorySkillCatalog();
    skills.register(makeSkill('review'));
    persistence = new InMemoryWireRecordPersistence();
    ctx = createTestAgent(
      skillServices(skills),
      wireRecordPersistenceServices(persistence),
    );
    context = ctx.get(IAgentLoopService);
    profile = ctx.get(IAgentLoopService);
    profile.update({ activeToolNames: ['Skill'] });
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('persists model-invoked inline skill reminders through agent wire', async () => {
    const skillCall: ToolCall = {
      type: 'function',
      id: 'call_skill',
      name: 'Skill',
      arguments: '{"skill":"review"}',
    };
    ctx.mockNextResponse({ type: 'text', text: 'I will load the review skill.' }, skillCall);
    ctx.mockNextResponse({ type: 'text', text: 'Review skill loaded.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Review this change' }] });
    await ctx.untilTurnEnd();

    const skillSplice = persistence.records.find(
      (record) => recordContainsSkillLoaded(record, 'review'),
    );
    if (skillSplice === undefined || !isRecordWithMessage(skillSplice)) {
      throw new Error('expected skill activation record');
    }
    expect(skillSplice.type).toBe('context.append_message');
    expect(skillSplice.message).toMatchObject({
      role: 'user',
      toolCalls: [],
      origin: expect.objectContaining({
        kind: 'skill_activation',
        skillName: 'review',
        trigger: 'model-tool',
      }),
    });
    expect(skillSplice.message.content).toEqual([
      {
        type: 'text',
        text: [
          'Skill tool loaded instructions for this request. Follow them.',
          '',
          '<skill-loaded name="review" trigger="model-tool" source="user" dir="/skills/review" args="">',
          'body of review',
          '</skill-loaded>',
        ].join('\n'),
      },
    ]);
    expect(persistence.records.some((record) => record.type === 'skill.activate')).toBe(false);
    expect(context.history().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'Review skill loaded.' }],
    });
    expect(context.history().at(-2)).toMatchObject({
      role: 'user',
      origin: {
        kind: 'skill_activation',
        skillName: 'review',
      },
    });
  });

  it('keeps nested model-tool calls in the parent workspace through the production chain', async () => {
    skills.registerVariants([
      { ...makeSkill('parent'), path: '/work/A/parent/SKILL.md', dir: '/work/A/parent', content: 'parent from A', workspaceDir: '/work/A' },
      { ...makeSkill('parent'), path: '/work/B/parent/SKILL.md', dir: '/work/B/parent', content: 'parent from B', workspaceDir: '/work/B' },
      { ...makeSkill('child'), path: '/work/A/child/SKILL.md', dir: '/work/A/child', content: 'child from A', workspaceDir: '/work/A' },
      { ...makeSkill('child'), path: '/work/B/child/SKILL.md', dir: '/work/B/child', content: 'child from B', workspaceDir: '/work/B' },
    ], { replace: true });
    const parentCall: ToolCall = {
      type: 'function',
      id: 'call_parent',
      name: 'Skill',
      arguments: '{"skill":"parent","path":"/work/B/parent/SKILL.md"}',
    };
    const childCall: ToolCall = {
      type: 'function',
      id: 'call_child',
      name: 'Skill',
      arguments: '{"skill":"child"}',
    };
    ctx.mockNextResponse({ type: 'text', text: 'Load parent from B.' }, parentCall);
    ctx.mockNextResponse({ type: 'text', text: 'Load its child.' }, childCall);
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use the parent skill' }] });
    await ctx.untilTurnEnd();

    const nested = persistence.records.filter((record) => recordContainsSkillLoaded(record, 'child'));
    expect(nested).toHaveLength(1);
    expect(JSON.stringify(nested[0])).toContain('child from B');
    expect(JSON.stringify(nested[0])).toContain('/work/B/child/SKILL.md');
    expect(JSON.stringify(nested[0])).toContain('nested-skill');
    expect(JSON.stringify(nested[0])).not.toContain('child from A');
  });
  it('uses the resolved depth for sibling nested calls', async () => {
    const names = ['parent', 'first', 'second', 'third'];
    for (const name of names) {
      skills.register({ ...makeSkill(name), path: `/work/A/${name}/SKILL.md`, dir: `/work/A/${name}`, content: `${name} from A`, workspaceDir: '/work/A' });
    }
    skills.registerVariants(names.flatMap((name) => [
      { ...makeSkill(name), path: `/work/A/${name}/SKILL.md`, dir: `/work/A/${name}`, content: `${name} from A`, workspaceDir: '/work/A' },
      { ...makeSkill(name), path: `/work/B/${name}/SKILL.md`, dir: `/work/B/${name}`, content: `${name} from B`, workspaceDir: '/work/B' },
    ]), { replace: true });
    const parentCall: ToolCall = {
      type: 'function',
      id: 'call_depth_parent',
      name: 'Skill',
      arguments: '{"skill":"parent","path":"/work/B/parent/SKILL.md"}',
    };
    const firstCall: ToolCall = {
      type: 'function',
      id: 'call_depth_first',
      name: 'Skill',
      arguments: '{"skill":"first"}',
    };
    const secondCall: ToolCall = {
      type: 'function',
      id: 'call_depth_second',
      name: 'Skill',
      arguments: '{"skill":"second"}',
    };
    const thirdCall: ToolCall = {
      type: 'function',
      id: 'call_depth_third',
      name: 'Skill',
      arguments: '{"skill":"third"}',
    };
    ctx.mockNextResponse({ type: 'text', text: 'Load the parent.' }, parentCall);
    ctx.mockNextResponse({ type: 'text', text: 'Load siblings.' }, firstCall, secondCall);
    ctx.mockNextResponse({ type: 'text', text: 'Load the next child.' }, thirdCall);
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use nested skills' }] });
    await ctx.untilTurnEnd();

    const nested = persistence.records.filter((record) =>
      names.slice(1).some((name) => recordContainsSkillLoaded(record, name)),
    );
    expect(nested).toHaveLength(3);
    for (const name of names.slice(1)) {
      expect(JSON.stringify(nested)).toContain(`${name} from B`);
      expect(JSON.stringify(nested)).toContain(`/work/B/${name}/SKILL.md`);
      expect(JSON.stringify(nested)).toContain('nested-skill');
    }
  });
  it('keeps the bundled parent workspace for nested model-tool calls', async () => {
    skills.registerVariants([
      { ...makeSkill('parent'), path: '/work/A/parent/SKILL.md', dir: '/work/A/parent', content: 'parent from A', workspaceDir: '/work/A' },
      { ...makeSkill('parent'), path: '/work/B/parent/SKILL.md', dir: '/work/B/parent', content: 'parent from B', workspaceDir: '/work/B' },
      { ...makeSkill('child'), path: '/work/A/child/SKILL.md', dir: '/work/A/child', content: 'child from A', workspaceDir: '/work/A' },
      { ...makeSkill('child'), path: '/work/B/child/SKILL.md', dir: '/work/B/child', content: 'child from B', workspaceDir: '/work/B' },
    ], { replace: true });
    const childCall: ToolCall = {
      type: 'function',
      id: 'call_child',
      name: 'Skill',
      arguments: '{"skill":"child"}',
    };
    ctx.mockNextResponse({ type: 'text', text: 'Load its child.' }, childCall);
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.promptWithSkills({
      input: [{ type: 'text', text: 'Use the parent skill' }],
      skills: [{ name: 'parent', path: '/work/B/parent/SKILL.md' }],
    });
    await ctx.untilTurnEnd();

    const nested = persistence.records.filter((record) => recordContainsSkillLoaded(record, 'child'));
    expect(nested).toHaveLength(1);
    expect(JSON.stringify(nested[0])).toContain('child from B');
    expect(JSON.stringify(nested[0])).toContain('/work/B/child/SKILL.md');
    expect(JSON.stringify(nested[0])).toContain('nested-skill');
    expect(JSON.stringify(nested[0])).not.toContain('child from A');
  });
  it('uses one context for all skill calls in the same assistant response', async () => {
    skills.register({ ...makeSkill('parent'), path: '/work/A/parent/SKILL.md', dir: '/work/A/parent', content: 'parent from A', workspaceDir: '/work/A' });
    skills.register({ ...makeSkill('child'), path: '/work/A/child/SKILL.md', dir: '/work/A/child', content: 'child from A', workspaceDir: '/work/A' });
    skills.registerVariants([
      { ...makeSkill('parent'), path: '/work/A/parent/SKILL.md', dir: '/work/A/parent', content: 'parent from A', workspaceDir: '/work/A' },
      { ...makeSkill('parent'), path: '/work/B/parent/SKILL.md', dir: '/work/B/parent', content: 'parent from B', workspaceDir: '/work/B' },
      { ...makeSkill('child'), path: '/work/A/child/SKILL.md', dir: '/work/A/child', content: 'child from A', workspaceDir: '/work/A' },
      { ...makeSkill('child'), path: '/work/B/child/SKILL.md', dir: '/work/B/child', content: 'child from B', workspaceDir: '/work/B' },
    ], { replace: true });
    const parentCall: ToolCall = {
      type: 'function',
      id: 'call_batch_parent',
      name: 'Skill',
      arguments: '{"skill":"parent","path":"/work/B/parent/SKILL.md"}',
    };
    const childCall: ToolCall = {
      type: 'function',
      id: 'call_batch_child',
      name: 'Skill',
      arguments: '{"skill":"child"}',
    };
    ctx.mockNextResponse({ type: 'text', text: 'Load siblings.' }, parentCall, childCall);
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use both skills' }] });
    await ctx.untilTurnEnd();

    const siblings = persistence.records.filter((record) => recordContainsSkillLoaded(record, 'child'));
    expect(siblings).toHaveLength(1);
    expect(JSON.stringify(siblings[0])).toContain('child from A');
    expect(JSON.stringify(siblings[0])).toContain('/work/A/child/SKILL.md');
    expect(JSON.stringify(siblings[0])).toContain('model-tool');
    expect(JSON.stringify(siblings[0])).not.toContain('child from B');
    expect(JSON.stringify(siblings[0])).not.toContain('nested-skill');
  });
  it('resets depth for sibling root calls after a batch', async () => {
    const names = ['first', 'second', 'third'];
    for (const name of names) {
      skills.register({ ...makeSkill(name), path: `/work/A/${name}/SKILL.md`, dir: `/work/A/${name}`, content: `${name} from A`, workspaceDir: '/work/A' });
    }
    const calls: ToolCall[] = names.map((name) => ({
      type: 'function',
      id: `call_${name}`,
      name: 'Skill',
      arguments: JSON.stringify({ skill: name }),
    }));
    const nextCall: ToolCall = {
      type: 'function',
      id: 'call_next',
      name: 'Skill',
      arguments: '{"skill":"first"}',
    };
    ctx.mockNextResponse({ type: 'text', text: 'Load siblings.' }, ...calls);
    ctx.mockNextResponse({ type: 'text', text: 'Load another sibling.' }, nextCall);
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use sibling skills' }] });
    await ctx.untilTurnEnd();

    const loaded = persistence.records.filter((record) =>
      names.some((name) => recordContainsSkillLoaded(record, name)),
    );
    expect(loaded).toHaveLength(4);
    expect(JSON.stringify(loaded.slice(0, 3))).not.toContain('nested-skill');
  });
  it('clears the parent workspace after a cross-workspace root batch', async () => {
    skills.register({ ...makeSkill('child'), path: '/work/A/child/SKILL.md', dir: '/work/A/child', content: 'child from A', workspaceDir: '/work/A' });
    skills.registerVariants([
      { ...makeSkill('parent'), path: '/work/A/parent/SKILL.md', dir: '/work/A/parent', content: 'parent from A', workspaceDir: '/work/A' },
      { ...makeSkill('parent'), path: '/work/B/parent/SKILL.md', dir: '/work/B/parent', content: 'parent from B', workspaceDir: '/work/B' },
      { ...makeSkill('child'), path: '/work/A/child/SKILL.md', dir: '/work/A/child', content: 'child from A', workspaceDir: '/work/A' },
      { ...makeSkill('child'), path: '/work/B/child/SKILL.md', dir: '/work/B/child', content: 'child from B', workspaceDir: '/work/B' },
    ], { replace: true });
    const parentA: ToolCall = {
      type: 'function',
      id: 'call_parent_a',
      name: 'Skill',
      arguments: '{"skill":"parent","path":"/work/A/parent/SKILL.md"}',
    };
    const parentB: ToolCall = {
      type: 'function',
      id: 'call_parent_b',
      name: 'Skill',
      arguments: '{"skill":"parent","path":"/work/B/parent/SKILL.md"}',
    };
    const parentBAgain: ToolCall = {
      type: 'function',
      id: 'call_parent_b_again',
      name: 'Skill',
      arguments: '{"skill":"parent","path":"/work/B/parent/SKILL.md"}',
    };
    const childCall: ToolCall = {
      type: 'function',
      id: 'call_child_after_batch',
      name: 'Skill',
      arguments: '{"skill":"child"}',
    };
    ctx.mockNextResponse({ type: 'text', text: 'Load both parents.' }, parentA, parentB, parentBAgain);
    ctx.mockNextResponse({ type: 'text', text: 'Load the child.' }, childCall);
    ctx.mockNextResponse({ type: 'text', text: 'Done.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use both parents' }] });
    await ctx.untilTurnEnd();

    const nested = persistence.records.filter((record) => recordContainsSkillLoaded(record, 'child'));
    expect(nested).toHaveLength(1);
    expect(JSON.stringify(nested[0])).toContain('child from A');
    expect(JSON.stringify(nested[0])).toContain('/work/A/child/SKILL.md');
    expect(JSON.stringify(nested[0])).toContain('model-tool');
    expect(JSON.stringify(nested[0])).not.toContain('child from B');
    expect(JSON.stringify(nested[0])).not.toContain('nested-skill');
  });
});

describe('ToolManager SkillTool restore behavior', () => {
  let ctx: TestAgentContext;
  let context: IAgentLoopService;
  let skills: InMemorySkillCatalog;
  let emit: ReturnType<typeof vi.spyOn>;
  let track: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    skills = new InMemorySkillCatalog();
    skills.register(makeSkill('review'));
    const telemetry = recordingTelemetry([]);
    track = vi.spyOn(telemetry, 'track2');
    ctx = createTestAgent(
      skillServices(skills),
      telemetryServices(telemetry),
    );
    context = ctx.get(IAgentLoopService);
    const events = ctx.get(IEventBus);
    emit = vi.spyOn(events, 'publish');
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('restores skill activation records before the skill service is otherwise used', async () => {
    const origin = {
      kind: 'skill_activation' as const,
      activationId: 'act_restore_skill',
      skillName: 'review',
      skillArgs: 'src/app.ts',
      trigger: 'user-slash' as const,
      skillPath: '/skills/review/SKILL.md',
      skillSource: 'user' as const,
    };
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'restored skill body' }],
      origin,
    };

    await ctx.restore([
      { type: 'skill.activate', origin },
      { type: 'context.append_message', message },
    ]);

    expect(emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'skill.activated' }),
    );
    expect(ctx.allEvents).not.toContainEqual(
      expect.objectContaining({ type: '[rpc]', event: 'skill.activated' }),
    );
    expect(track).not.toHaveBeenCalledWith('skill_invoked', expect.anything());
    expect(context.history()).toMatchObject([message]);
  });
});

describe('ToolManager SkillTool workspace refresh', () => {
  let ctx: TestAgentContext;
  let profile: IAgentLoopService;
  let tmp: string;
  let tools: IAgentToolRegistryService;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'kimi-core-skill-tool-refresh-'));
    const workDir = join(tmp, 'work');
    const skillDir = join(workDir, '.kimi-code', 'skills', 'review');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      ['---', 'name: review', 'description: Review code', '---', '', 'Review body.'].join('\n'),
    );

    const skills = new InMemorySkillCatalog();
    const skill = {
      ...makeSkill('review'),
      description: 'Review code',
      path: join(skillDir, 'SKILL.md'),
      dir: skillDir,
      content: 'Review body.',
    };
    skills.register(skill);

    ctx = createTestAgent(
      { cwd: workDir },
      skillServices(skills),
    );
    profile = ctx.get(IAgentLoopService);
    tools = ctx.get(IAgentToolRegistryService);
    profile.update({ activeToolNames: ['Skill'] });
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      try {
        await ctx.dispose();
      } finally {
        await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
      }
    }
  });

  it('exposes session skills after the main agent is created', () => {
    expect(tools.resolve('Skill')).toMatchObject({ name: 'Skill' });
  });
});
