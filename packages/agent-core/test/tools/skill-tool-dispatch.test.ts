import { describe, expect, it, vi } from 'vitest';

import type { Agent } from '../../src/agent';
import type { SkillActivationOrigin } from '../../src/agent/context';
import type { SkillRegistry as AgentSkillRegistry } from '../../src/agent/skill';
import { SessionSkillRegistry, type SkillDefinition } from '../../src/skill';
import {
  MAX_SKILL_QUERY_DEPTH,
  NestedSkillTooDeepError,
  SkillTool,
} from '../../src/tools/builtin/collaboration/skill-tool';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function skill(name: string, metadata: SkillDefinition['metadata'] = {}): SkillDefinition {
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

function registry(skills: readonly SkillDefinition[] = []): AgentSkillRegistry {
  const registry = new SessionSkillRegistry();
  for (const item of skills) {
    registry.register(item);
  }
  return registry;
}

interface SkillToolMethods {
  readonly recordSkillActivation: (origin: SkillActivationOrigin) => void;
  readonly recordSystemReminder: (content: string, origin: SkillActivationOrigin) => void;
  readonly recordUserMessage: (
    content: readonly [{ readonly type: 'text'; readonly text: string }],
    origin: SkillActivationOrigin,
  ) => void;
}

function skillToolMethods() {
  return {
    recordSkillActivation: vi.fn<SkillToolMethods['recordSkillActivation']>(),
    recordSystemReminder: vi.fn<SkillToolMethods['recordSystemReminder']>(),
    recordUserMessage: vi.fn<SkillToolMethods['recordUserMessage']>(),
  } satisfies SkillToolMethods;
}

function skillToolAgent(skills: AgentSkillRegistry, methods: SkillToolMethods): Agent {
  return {
    skills: {
      registry: skills,
      recordActivation: methods.recordSkillActivation,
    },
    context: {
      appendSystemReminder: methods.recordSystemReminder,
      appendUserMessage: methods.recordUserMessage,
    },
  } as unknown as Agent;
}

function skillTool(
  skills: AgentSkillRegistry,
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

describe('SkillTool dispatch edges', () => {
  it('treats prompt skills as inline skills', async () => {
    const methods = skillToolMethods();
    const tool = skillTool(registry([skill('prompt-skill', { type: 'prompt' })]), methods);

    const result = await execute(tool, { skill: 'prompt-skill' });

    expect(result.output).toContain('loaded inline');
    expect(result.output).not.toContain('body of prompt-skill');
    expect(methods.recordUserMessage.mock.calls[0]?.[0][0]?.text).toContain(
      'body of prompt-skill',
    );
    expect(methods.recordUserMessage.mock.calls[0]?.[0][0]?.text).not.toContain(
      '<system-reminder>',
    );
    expect(methods.recordSkillActivation).toHaveBeenCalledTimes(1);
  });

  it('treats omitted skill type as inline for backwards-compatible skill files', async () => {
    const methods = skillToolMethods();
    const tool = skillTool(registry([skill('legacy')]), methods);

    const result = await execute(tool, { skill: 'legacy' });

    expect(result.output).toContain('loaded inline');
    expect(result.output).not.toContain('body of legacy');
    expect(methods.recordUserMessage.mock.calls[0]?.[0][0]?.text).toContain('body of legacy');
    expect(methods.recordUserMessage.mock.calls[0]?.[0][0]?.text).not.toContain(
      '<system-reminder>',
    );
    expect(methods.recordSkillActivation).toHaveBeenCalledTimes(1);
  });

  it('honors initialQueryDepth as an alias for queryDepth', async () => {
    const tool = skillTool(registry([skill('loop')]), skillToolMethods(), {
      initialQueryDepth: MAX_SKILL_QUERY_DEPTH,
    });

    await expect(execute(tool, { skill: 'loop' })).rejects.toBeInstanceOf(NestedSkillTooDeepError);
  });
});
