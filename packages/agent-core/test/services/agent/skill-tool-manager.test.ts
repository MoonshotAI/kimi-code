import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { testAgent } from './harness';
import { InMemoryWireRecordPersistence } from '../../../src/services/agent';
import { SessionSkillRegistry, type SkillCatalog, type SkillDefinition } from '../../../src/skill';
import { testKaos } from '../../fixtures/test-kaos';

function makeSkill(name: string, metadata: SkillDefinition['metadata'] = {}): SkillDefinition {
  return {
    name,
    description: `desc for ${name}`,
    path: `/skills/${name}/SKILL.md`,
    dir: `/skills/${name}`,
    content: `body of ${name}`,
    metadata,
    source: 'user',
  };
}

describe('ToolManager SkillTool registration', () => {
  it('does not expose Skill when the agent has no skill registry', () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Skill'] });

    expect(ctx.toolsData().find((tool) => tool.name === 'Skill')).toBeUndefined();
    expect(ctx.tools.resolve('Skill')).toBeUndefined();
  });

  it('does not expose Skill when there are no model-invocable skills', () => {
    const skills = new SessionSkillRegistry();
    skills.register(makeSkill('private', { disableModelInvocation: true }));

    const ctx = testAgent({ skills });
    ctx.configure({ tools: ['Skill'] });

    expect(ctx.toolsData().find((tool) => tool.name === 'Skill')).toBeUndefined();
    expect(ctx.tools.resolve('Skill')).toBeUndefined();
  });

  it('exposes Skill when at least one inline skill is model-invocable', () => {
    const skills = new SessionSkillRegistry();
    skills.register(makeSkill('review'));
    skills.register(makeSkill('flow-only', { type: 'flow' }));

    const ctx = testAgent({ skills });
    ctx.configure({ tools: ['Skill'] });

    const skillInfo = ctx.toolsData().find((tool) => tool.name === 'Skill');
    const skillTool = ctx.tools.resolve('Skill');

    expect(skillInfo).toMatchObject({ name: 'Skill', active: true, source: 'builtin' });
    expect(skillTool).toMatchObject({
      name: 'Skill',
      description: expect.stringContaining('Invoke a registered skill'),
    });
  });

  it('accepts a structural skill registry implementation', () => {
    const skill = makeSkill('review');
    const skills: SkillCatalog = {
      getSkill: (name) => (name === skill.name ? skill : undefined),
      getPluginSkill: () => undefined,
      renderSkillPrompt: () => skill.content,
      listInvocableSkills: () => [skill],
      getSkillRoots: () => ['/skills/review'],
      getModelSkillListing: () => '- review: desc for review',
    };

    const ctx = testAgent({ skills });
    ctx.configure({ tools: ['Skill'] });

    expect(skills.getSkillRoots()).toEqual(['/skills/review']);
    expect(ctx.tools.resolve('Skill')).toMatchObject({ name: 'Skill' });
  });

  it('persists model-invoked inline skill reminders through agent wire', async () => {
    const skills = new SessionSkillRegistry();
    skills.register(makeSkill('review'));
    const wireRecords: any[] = [];
    const persistence = new InMemoryWireRecordPersistence([], {
      onRecord: (record: any) => wireRecords.push(record),
    });
    const ctx = testAgent({ skills, persistence });
    ctx.configure({ tools: ['Skill'] });

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

    const skillSplice = wireRecords.find(
      (record) =>
        record.type === 'context.splice' &&
        record.messages?.some((message: any) =>
          message.content?.some(
            (part: any) =>
              part.type === 'text' &&
              part.text.includes('<kimi-skill-loaded name="review"'),
          ),
        ),
    );
    expect(skillSplice).toMatchObject({
      type: 'context.splice',
      messages: [
        expect.objectContaining({
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
      ],
    });
    expect(wireRecords.find((record) => record.type === 'skill.activate')).toMatchObject({
      type: 'skill.activate',
      origin: {
        kind: 'skill_activation',
        skillName: 'review',
        trigger: 'model-tool',
      },
    });
    expect(ctx.context.getHistory().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'Review skill loaded.' }],
    });
    expect(ctx.context.getHistory().at(-2)).toMatchObject({
      role: 'user',
      origin: {
        kind: 'skill_activation',
        skillName: 'review',
      },
    });
  });

  it('exposes session skills after the main agent is created', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'kimi-core-skill-tool-refresh-'));
    try {
      const homeDir = join(tmp, 'home');
      const workDir = join(tmp, 'work');
      const skillDir = join(workDir, '.kimi-code', 'skills', 'review');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        ['---', 'name: review', 'description: Review code', '---', '', 'Review body.'].join('\n'),
      );

      const skills = new SessionSkillRegistry();
      const skill = {
        ...makeSkill('review'),
        description: 'Review code',
        path: join(skillDir, 'SKILL.md'),
        dir: skillDir,
        content: 'Review body.',
      };
      skills.register(skill);

      const ctx = testAgent({
        kaos: testKaos.withCwd(workDir),
        skills,
      });
      ctx.configure({ tools: ['Skill'] });

      expect(ctx.tools.resolve('Skill')).toMatchObject({ name: 'Skill' });
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    }
  });
});
