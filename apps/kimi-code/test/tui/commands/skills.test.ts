import { buildSkillSlashCommands, isUserActivatableSkill } from '#/tui/commands/index';
import type { SkillSummary } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

function skill(
  name: string,
  type?: SkillSummary['type'],
  extra: Partial<SkillSummary> = {},
): SkillSummary {
  return {
    name,
    type,
    description: `${name} skill`,
    ...extra,
  } as SkillSummary;
}

describe('skill slash commands', () => {
  it('allows user-activatable skill types', () => {
    expect(isUserActivatableSkill(skill('default'))).toBe(true);
    expect(isUserActivatableSkill(skill('prompt', 'prompt'))).toBe(true);
    expect(isUserActivatableSkill(skill('inline', 'inline'))).toBe(true);
    expect(isUserActivatableSkill(skill('flow', 'flow'))).toBe(true);
  });

  it('filters non-user-activatable skill types', () => {
    expect(isUserActivatableSkill(skill('agent', 'agent'))).toBe(false);
  });

  it('builds slash commands and command map entries with skill prefixes for non-built-in skills', () => {
    const built = buildSkillSlashCommands([
      skill('review', 'prompt'),
      skill('nested-review', 'prompt', {
        description: 'Nested review skill',
        path: '/skills/parent/nested-review/SKILL.md',
      }),
      skill('agent-only', 'agent'),
      skill('flow:commit', 'flow'),
    ]);

    expect(built.commands.map((command) => command.name)).toEqual([
      'flow:commit',
      'skill:nested-review',
      'skill:review',
    ]);
    expect(built.commands[0]).toMatchObject({
      name: 'flow:commit',
      aliases: [],
      description: 'flow:commit skill',
    });
    expect(built.commands[1]).toMatchObject({
      name: 'skill:nested-review',
      aliases: [],
      description: 'Nested review skill',
    });
    expect([...built.commandMap.entries()]).toEqual([
      ['flow:commit', 'flow:commit'],
      ['skill:nested-review', 'nested-review'],
      ['skill:review', 'review'],
    ]);
  });

  it('keeps the skill prefix for an ordinary flow-typed skill outside the flow namespace', () => {
    const built = buildSkillSlashCommands([skill('daily-report', 'flow')]);
    expect(built.commands.map((command) => command.name)).toEqual(['skill:daily-report']);
    expect(built.commandMap.get('skill:daily-report')).toBe('daily-report');
  });

  it('sorts built-in skill slash commands before external skill commands', () => {
    const built = buildSkillSlashCommands([
      skill('zeta', 'prompt', { source: 'user' }),
      skill('alpha', 'prompt', { source: 'project' }),
      skill('update-config', 'inline', { source: 'builtin' }),
      skill('mcp-config', 'inline', { source: 'builtin' }),
    ]);

    expect(built.commands.map((command) => command.name)).toEqual([
      'mcp-config',
      'update-config',
      'skill:alpha',
      'skill:zeta',
    ]);
    expect([...built.commandMap.entries()]).toEqual([
      ['mcp-config', 'mcp-config'],
      ['update-config', 'update-config'],
      ['skill:alpha', 'alpha'],
      ['skill:zeta', 'zeta'],
    ]);
  });

  it('keeps disableModelInvocation skills slash-invocable', () => {
    const built = buildSkillSlashCommands([
      skill('mcp-config', 'inline', { disableModelInvocation: true, source: 'builtin' }),
    ]);

    expect(built.commands.map((command) => command.name)).toEqual(['mcp-config']);
    expect(built.commandMap.get('mcp-config')).toBe('mcp-config');
  });

  it('keeps sub-skills slash-invocable', () => {
    const built = buildSkillSlashCommands([
      skill('outer.inner', 'prompt', {
        isSubSkill: true,
        source: 'project',
      }),
    ]);

    expect(built.commands.map((command) => command.name)).toEqual(['outer.inner']);
    expect(built.commandMap.get('outer.inner')).toBe('outer.inner');
  });
});
