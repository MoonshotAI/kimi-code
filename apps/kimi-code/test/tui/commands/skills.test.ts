import { buildSkillSlashCommands, isUserActivatableSkill, skillSourceLabel } from '#/tui/commands/index';
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
      skill('commit', 'flow'),
    ]);

    expect(built.commands.map((command) => command.name)).toEqual([
      'skill:commit',
      'skill:nested-review',
      'skill:review',
    ]);
    expect(built.commands[0]).toMatchObject({
      name: 'skill:commit',
      aliases: [],
      description: 'commit skill',
    });
    expect(built.commands[1]).toMatchObject({
      name: 'skill:nested-review',
      aliases: [],
      description: 'Nested review skill',
    });
    expect([...built.commandMap.entries()]).toEqual([
      ['skill:commit', 'commit'],
      ['skill:nested-review', 'nested-review'],
      ['skill:review', 'review'],
    ]);
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

  it('keeps same-name variants while the command map retains the default', () => {
    const built = buildSkillSlashCommands([
      skill('review', 'prompt', {
        path: '/work/A/review/SKILL.md',
        workspaceDir: '/work/A',
        source: 'project',
      }),
      skill('review', 'prompt', {
        path: '/work/B/review/SKILL.md',
        workspaceDir: '/work/B',
        source: 'project',
      }),
    ]);

    expect(built.commands).toHaveLength(2);
    expect(built.commands.map((command) => command.skillPath)).toEqual([
      '/work/A/review/SKILL.md',
      '/work/B/review/SKILL.md',
    ]);
    expect(built.commands.map((command) => command.workspaceDir)).toEqual(['/work/A', '/work/B']);
    expect(built.commandMap.get('skill:review')).toBe('review');
    expect([...built.commandMap.keys()].filter((name) => name === 'skill:review')).toHaveLength(1);
    expect(built.defaultPaths.has('skill:review')).toBe(false);
  });

  it('uses the first TUI-visible variant as the default path when the default is filtered out', () => {
    const built = buildSkillSlashCommands([
      skill('review', 'prompt', {
        path: '/work/A/review/SKILL.md',
        workspaceDir: '/work/A',
        source: 'project',
        scopes: ['web'],
      }),
      skill('review', 'prompt', {
        path: '/work/B/review/SKILL.md',
        workspaceDir: '/work/B',
        source: 'project',
        scopes: ['tui'],
      }),
    ]);

    expect(built.commands).toHaveLength(1);
    expect(built.commands[0]?.skillPath).toBe('/work/B/review/SKILL.md');
    expect(built.defaultPaths.get('skill:review')).toBe('/work/B/review/SKILL.md');
  });

  it('labels global and built-in sources without changing project metadata', () => {
    expect(skillSourceLabel('user')).toBe('Global');
    expect(skillSourceLabel('extra')).toBe('Global');
    expect(skillSourceLabel('builtin')).toBe('Built-in');
    expect(skillSourceLabel('project')).toBeUndefined();
    expect(skillSourceLabel(undefined)).toBeUndefined();

    const built = buildSkillSlashCommands([
      skill('global', 'prompt', { source: 'user' }),
      skill('builtin', 'prompt', { source: 'builtin' }),
      skill('project', 'prompt', { source: 'project' }),
    ]);
    expect(built.commands.map((command) => command.skillSource)).toEqual(['builtin', 'user', 'project']);
    expect(built.commands.every((command) => command.isSkill === true)).toBe(true);
  });

  it('normalizes command keys while retaining exact-case variant paths', () => {
    const built = buildSkillSlashCommands([
      skill('Review', 'prompt', {
        path: '/work/A/review/SKILL.md',
        workspaceDir: '/work/A',
        source: 'project',
      }),
      skill('review', 'prompt', {
        path: '/work/B/review/SKILL.md',
        workspaceDir: '/work/B',
        source: 'project',
      }),
    ]);

    expect(built.commands.map((command) => command.name)).toEqual(
      expect.arrayContaining(['skill:Review', 'skill:review']),
    );
    expect(built.commandMap.has('skill:review')).toBe(true);
    expect(built.defaultPaths.get('skill:Review')).toBe('/work/A/review/SKILL.md');
    expect(built.defaultPaths.get('skill:review')).toBe('/work/B/review/SKILL.md');
  });

  it('filters skills restricted to other scopes', () => {
    const built = buildSkillSlashCommands([
      skill('custom-theme', 'inline', { source: 'builtin', scopes: ['tui'] }),
      skill('web-helper', 'inline', { source: 'builtin', scopes: ['web'] }),
      skill('write-goal', 'inline', { source: 'builtin' }),
    ]);

    expect(built.commands.map((command) => command.name)).toEqual(['custom-theme', 'write-goal']);
    expect(built.commandMap.has('web-helper')).toBe(false);
  });
});
