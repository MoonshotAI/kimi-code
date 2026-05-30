import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import type { SkillActivationOrigin } from '../../src/agent/context';
import { SkillRegistry, type SkillDefinition } from '../../src/skill';
import {
  MAX_SKILL_QUERY_DEPTH,
  NestedSkillTooDeepError,
  SkillTool,
  SkillToolInputSchema,
} from '../../src/tools/builtin/collaboration/skill-tool';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function skill(
  name: string,
  metadata: SkillDefinition['metadata'] = {},
  content = `body of ${name}`,
): SkillDefinition {
  return {
    name,
    description: `desc for ${name}`,
    path: `/skills/${name}/SKILL.md`,
    dir: `/skills/${name}`,
    content,
    metadata,
    source: 'user',
  };
}

function registry(
  skills: readonly SkillDefinition[] = [],
  options: { readonly sessionId?: string } = {},
): SkillRegistry {
  const registry = new SkillRegistry(options);
  for (const item of skills) {
    registry.register(item);
  }
  return registry;
}

interface SkillToolMethods {
  readonly recordSkillActivation: (origin: SkillActivationOrigin) => void;
  readonly recordSystemReminder: (content: string, origin: SkillActivationOrigin) => void;
}

function skillToolMethods() {
  return {
    recordSkillActivation: vi.fn<SkillToolMethods['recordSkillActivation']>(),
    recordSystemReminder: vi.fn<SkillToolMethods['recordSystemReminder']>(),
  } satisfies SkillToolMethods;
}

function skillToolAgent(skills: SkillRegistry, methods: SkillToolMethods): Agent {
  return {
    skills: {
      registry: skills,
      recordActivation: methods.recordSkillActivation,
    },
    context: {
      appendSystemReminder: methods.recordSystemReminder,
    },
  } as unknown as Agent;
}

function skillTool(
  skills: SkillRegistry,
  methods = skillToolMethods(),
  options?: ConstructorParameters<typeof SkillTool>[1],
): SkillTool {
  return new SkillTool(skillToolAgent(skills, methods), options);
}

function execute(tool: SkillTool, args: { skill: string; args?: string }) {
  return executeTool(tool, {
    turnId: '0',
    toolCallId: 'call_skill',
    args,
    signal,
  });
}

describe('SkillTool metadata and schema', () => {
  it('exposes the current tool contract', () => {
    const tool = skillTool(registry());

    expect(tool.name).toBe('Skill');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { skill: { type: 'string' } },
    });
    expect(SkillToolInputSchema.safeParse({ skill: 'commit' }).success).toBe(true);
    expect(SkillToolInputSchema.safeParse({ skill: 'commit', args: '-m fix' }).success).toBe(true);
    expect(SkillToolInputSchema.safeParse({}).success).toBe(false);
    expect(MAX_SKILL_QUERY_DEPTH).toBe(3);
  });
});

describe('SkillTool execution', () => {
  it('returns a tool error when the skill is unknown', async () => {
    const tool = skillTool(registry());

    const result = await execute(tool, { skill: 'missing' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('not found');
  });

  it('rejects skills that disable model invocation', async () => {
    const tool = skillTool(registry([skill('secret', { disableModelInvocation: true })]));

    const result = await execute(tool, { skill: 'secret' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('can only be triggered by the user');
  });

  it('rejects non-inline skill types in the current v1 runtime', async () => {
    const methods = skillToolMethods();
    const tool = skillTool(registry([skill('review', { type: 'fork' })]), methods);

    const result = await execute(tool, { skill: 'review' });

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('not an inline skill');
    expect(methods.recordSkillActivation).not.toHaveBeenCalled();
  });

  it('records inline skill content as a system reminder', async () => {
    const methods = skillToolMethods();
    const tool = skillTool(registry([skill('commit')]), methods);

    const result = await execute(tool, { skill: 'commit', args: 'message text' });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('loaded inline');
    expect(result.output).not.toContain('body of commit');
    expect(methods.recordSkillActivation).toHaveBeenCalledTimes(1);
    expect(methods.recordSystemReminder).toHaveBeenCalledTimes(1);
    expect(methods.recordSystemReminder.mock.calls[0]?.[0]).toContain(
      '<kimi-skill-loaded name="commit" args="message text">\nbody of commit\n\nARGUMENTS: message text\n</kimi-skill-loaded>',
    );
  });

  it('keeps plugin instructions adjacent to model-invoked skill content', async () => {
    const methods = skillToolMethods();
    const tool = skillTool(
      registry([
        {
          ...skill('brainstorming', {}, 'brainstorm body'),
          source: 'extra',
          plugin: {
            id: 'superpowers',
            instructions: 'Use AskUserQuestion for clarifying questions.',
          },
        },
      ]),
      methods,
    );

    await execute(tool, { skill: 'brainstorming' });

    expect(methods.recordSystemReminder.mock.calls[0]?.[0]).toContain(
      '<kimi-skill-loaded name="brainstorming" args="">\n' +
        '<kimi-plugin-instructions plugin="superpowers">\n' +
        'Use AskUserQuestion for clarifying questions.\n' +
        '</kimi-plugin-instructions>\n\nbrainstorm body\n' +
        '</kimi-skill-loaded>',
    );
  });

  it('expands skill body placeholders for model-invoked inline skills', async () => {
    const methods = skillToolMethods();
    const tool = skillTool(
      registry([
        skill(
          'commit',
          { arguments: ['flag', 'message'] },
          'Flag: $flag\nCommit message: $message\nRaw: $ARGUMENTS',
        ),
      ]),
      methods,
    );

    await execute(tool, { skill: 'commit', args: '-m "fix login"' });

    expect(methods.recordSystemReminder.mock.calls[0]?.[0]).toContain(
      '<kimi-skill-loaded name="commit" args="-m &quot;fix login&quot;">\nFlag: -m\nCommit message: fix login\nRaw: -m "fix login"\n</kimi-skill-loaded>',
    );
    expect(methods.recordSystemReminder.mock.calls[0]?.[0]).not.toContain('ARGUMENTS:');
  });

  it('expands session id from the skill registry for model-invoked skills', async () => {
    const methods = skillToolMethods();
    const tool = skillTool(
      registry([skill('session-aware', {}, 'Session: ${KIMI_SESSION_ID}')], {
        sessionId: 'ses_model_skill',
      }),
      methods,
    );

    await execute(tool, { skill: 'session-aware' });

    expect(methods.recordSystemReminder.mock.calls[0]?.[0]).toContain(
      '<kimi-skill-loaded name="session-aware" args="">\nSession: ses_model_skill\n</kimi-skill-loaded>',
    );
  });

  it('notifies inline skill activation without exposing the skill body', async () => {
    const methods = skillToolMethods();
    const tool = skillTool(registry([skill('commit')]), methods);

    await execute(tool, { skill: 'commit', args: 'message text' });

    expect(methods.recordSkillActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'skill_activation',
        activationId: expect.any(String),
        skillName: 'commit',
        skillArgs: 'message text',
        trigger: 'model-tool',
        skillPath: '/skills/commit/SKILL.md',
        skillSource: 'user',
      }),
    );
    expect(JSON.stringify(methods.recordSkillActivation.mock.calls[0]?.[0])).not.toContain(
      'body of commit',
    );
  });

  it('escapes skill name and args in the wrapper boundaries', async () => {
    const methods = skillToolMethods();
    const tool = skillTool(registry([skill('a&b')]), methods);

    await execute(tool, { skill: 'a&b', args: '<raw "value">' });

    expect(methods.recordSystemReminder.mock.calls[0]?.[0]).toContain(
      '<kimi-skill-loaded name="a&amp;b" args="&lt;raw &quot;value&quot;&gt;">\nbody of a&b\n\nARGUMENTS: &lt;raw "value"&gt;\n</kimi-skill-loaded>',
    );
    expect(methods.recordSkillActivation).toHaveBeenCalledTimes(1);
  });

  it('marks nested skill activations when invoked from inside another skill', async () => {
    const methods = skillToolMethods();
    const tool = skillTool(registry([skill('nested')]), methods, { queryDepth: 1 });

    await execute(tool, { skill: 'nested' });

    expect(methods.recordSkillActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'skill_activation',
        skillName: 'nested',
        trigger: 'nested-skill',
      }),
    );
  });
});

describe('SkillTool recursion guard', () => {
  it('throws NestedSkillTooDeepError when the depth cap has already been reached', async () => {
    const tool = skillTool(registry([skill('loop')]), skillToolMethods(), {
      queryDepth: MAX_SKILL_QUERY_DEPTH,
    });

    await expect(execute(tool, { skill: 'loop' })).rejects.toBeInstanceOf(NestedSkillTooDeepError);
  });

  it('withInitialQueryDepth returns a tool seeded with that depth', async () => {
    const tool = skillTool(registry([skill('loop')])).withInitialQueryDepth(MAX_SKILL_QUERY_DEPTH);

    await expect(execute(tool, { skill: 'loop' })).rejects.toBeInstanceOf(NestedSkillTooDeepError);
  });
});
