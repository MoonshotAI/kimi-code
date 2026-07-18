import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { ToolCall } from '#/app/llmProtocol/message';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentProfileService } from '#/agent/profile/profile';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import { type SkillCatalog, type SkillDefinition } from '#/app/skillCatalog/types';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import {
  InMemoryWireRecordPersistence,
  createTestAgent,
  skillServices,
  telemetryServices,
  wireRecordPersistenceServices,
  type TestAgentContext,
} from '../../harness';
import { recordingTelemetry } from '../telemetry/stubs';
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
        part.text.includes(`<kimi-skill-loaded name="${skillName}"`)
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
  let profile: IAgentProfileService;
  let tools: IAgentToolRegistryService;

  beforeEach(() => {
    ctx = createTestAgent();
    profile = ctx.get(IAgentProfileService);
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
  let profile: IAgentProfileService;
  let tools: IAgentToolRegistryService;
  let skills: InMemorySkillCatalog;

  beforeEach(() => {
    skills = new InMemorySkillCatalog();
    skills.register(makeSkill('private', { disableModelInvocation: true }));
    ctx = createTestAgent(skillServices(skills));
    profile = ctx.get(IAgentProfileService);
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
  let profile: IAgentProfileService;
  let tools: IAgentToolRegistryService;
  let skills: InMemorySkillCatalog;

  beforeEach(() => {
    skills = new InMemorySkillCatalog();
    skills.register(makeSkill('review'));
    skills.register(makeSkill('flow-only', { type: 'flow' }));
    ctx = createTestAgent(skillServices(skills));
    profile = ctx.get(IAgentProfileService);
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
  let profile: IAgentProfileService;
  let tools: IAgentToolRegistryService;
  let skills: SkillCatalog;

  beforeEach(() => {
    const skill = makeSkill('review');
    skills = {
      getSkill: (name) => (name === skill.name ? skill : undefined),
      getPluginSkill: () => undefined,
      renderSkillPrompt: () => skill.content,
      listSkills: () => [skill],
      listInvocableSkills: () => [skill],
      getSkillRoots: () => ['/skills/review'],
      getSkippedByPolicy: () => [],
      getModelSkillListing: () => '- review: desc for review',
    };
    ctx = createTestAgent(skillServices(skills));
    profile = ctx.get(IAgentProfileService);
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

describe('ToolManager SkillTool wire behavior', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
  let profile: IAgentProfileService;
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
    context = ctx.get(IAgentContextMemoryService);
    profile = ctx.get(IAgentProfileService);
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
    expect(skillSplice).toMatchObject({
      type: 'context.append_message',
      message: expect.objectContaining({
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              'Skill tool loaded instructions for this request. Follow them.',
              '',
              '<kimi-skill-loaded name="review" trigger="model-tool" source="user" dir="/skills/review" args="">',
              'body of review',
              '</kimi-skill-loaded>',
            ].join('\n'),
          },
        ],
        origin: expect.objectContaining({
          kind: 'skill_activation',
          skillName: 'review',
          trigger: 'model-tool',
        }),
      }),
    });
    expect(persistence.records.some((record) => record.type === 'skill.activate')).toBe(false);
    expect(context.get().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'Review skill loaded.' }],
    });
    expect(context.get().at(-2)).toMatchObject({
      role: 'user',
      origin: {
        kind: 'skill_activation',
        skillName: 'review',
      },
    });
  });
});

describe('ToolManager SkillTool restore behavior', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;
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
    context = ctx.get(IAgentContextMemoryService);
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
      toolCalls: [],
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
    expect(context.get()).toMatchObject([message]);
  });
});

describe('ToolManager SkillTool workspace refresh', () => {
  let ctx: TestAgentContext;
  let profile: IAgentProfileService;
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
    profile = ctx.get(IAgentProfileService);
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
