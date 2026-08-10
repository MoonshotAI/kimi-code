import {
  buildSkillSlashCommands,
  handleSkillsCommand,
  isUserActivatableSkill,
  skillSlashCommandName,
  type SlashCommandHost,
} from '#/tui/commands/index';
import type { SkillSummary } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

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

  it('uses the same effective slash command names as autocomplete', () => {
    expect(skillSlashCommandName(skill('builtin', 'inline', { source: 'builtin' }))).toBe(
      'builtin',
    );
    expect(skillSlashCommandName(skill('review', 'prompt', { source: 'project' }))).toBe(
      'skill:review',
    );
    expect(
      skillSlashCommandName(skill('outer.inner', 'prompt', { source: 'project', isSubSkill: true })),
    ).toBe('outer.inner');
    expect(skillSlashCommandName(skill('reference', 'reference'))).toBeUndefined();
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
});

describe('/skills command', () => {
  it('shows loaded skills and diagnostics, then inserts the selected slash command', async () => {
    let panel: { render(width: number): string[]; handleInput(data: string): void } | undefined;
    const session = {
      inspectSkills: vi.fn(async () => ({
        skills: [
          skill('review', 'prompt', {
            source: 'project',
            path: '/repo/.agents/skills/review/SKILL.md',
          }),
        ],
        diagnostics: [
          {
            path: '/repo/.agents/skills/broken/SKILL.md',
            type: 'invalid',
            reason: 'Missing frontmatter',
          },
        ],
      })),
    };
    const host = {
      state: { appState: { workDir: '/repo' } },
      session,
      harness: { inspectWorkspaceSkills: vi.fn() },
      mountEditorReplacement: vi.fn((next) => { panel = next; }),
      restoreEditor: vi.fn(),
      restoreInputText: vi.fn(),
      showError: vi.fn(),
      showStatus: vi.fn(),
    } as unknown as SlashCommandHost;

    await handleSkillsCommand(host);

    const rendered = panel?.render(120).join('\n') ?? '';
    expect(rendered).toContain('Skills (1 loaded)');
    expect(rendered).toContain('/skill:review');
    expect(rendered).toContain('/repo/.agents/skills/review/SKILL.md');
    expect(rendered).toContain('/repo/.agents/skills/broken/SKILL.md: Missing frontmatter');

    panel?.handleInput('\r');
    expect(host.restoreEditor).toHaveBeenCalledOnce();
    expect(host.restoreInputText).toHaveBeenCalledWith('/skill:review ');
  });

  it('uses workspace discovery before a lazy v2 session exists', async () => {
    const inspectWorkspaceSkills = vi.fn(async () => ({ skills: [], diagnostics: [] }));
    const host = {
      state: { appState: { workDir: '/repo' } },
      session: undefined,
      harness: { inspectWorkspaceSkills },
      mountEditorReplacement: vi.fn(),
      showError: vi.fn(),
    } as unknown as SlashCommandHost;

    await handleSkillsCommand(host);

    expect(inspectWorkspaceSkills).toHaveBeenCalledWith('/repo');
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
  });
});
