import { describe, expect, it } from 'vitest';

import { buildSkillsReportLines } from '#/tui/components/messages/skills-panel';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const mockSkills = [
  { name: 'gen-changesets', description: 'Generate changesets', path: '/a', source: 'builtin' as const, type: 'inline' },
  { name: 'gen-docs', description: 'Update docs after code changes', path: '/b', source: 'builtin' as const, type: 'inline' },
  { name: 'my-project-skill', description: 'Custom project workflow', path: '/c', source: 'project' as const, type: 'flow' },
  { name: 'user-snippet', description: 'Personal snippet', path: '/d', source: 'user' as const },
  { name: 'extra-helper', description: 'Extra helper skill', path: '/e', source: 'extra' as const, type: 'prompt' },
];

describe('skills panel report lines', () => {
  it('renders a grouped table with aligned columns', () => {
    const lines = buildSkillsReportLines({
      colors: darkColors,
      skills: mockSkills,
    }).map(strip);

    const output = lines.join('\n');

    // Global header
    expect(output).toContain('Name');
    expect(output).toContain('Type');
    expect(output).toContain('Description');

    // Group labels
    expect(output).toContain('Built-in');
    expect(output).toContain('Project');
    expect(output).toContain('User');
    expect(output).toContain('Extra');

    // Skill rows
    expect(output).toContain('gen-changesets');
    expect(output).toContain('gen-docs');
    expect(output).toContain('my-project-skill');
    expect(output).toContain('user-snippet');
    expect(output).toContain('extra-helper');

    // Empty groups should be omitted — verify only one Project row exists
    const projectMatches = output.split('Project').length - 1;
    expect(projectMatches).toBe(1);
  });

  it('renders empty state when no skills are available', () => {
    const lines = buildSkillsReportLines({
      colors: darkColors,
      skills: [],
    }).map(strip);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('No skills available');
  });

  it('skips empty source groups', () => {
    const lines = buildSkillsReportLines({
      colors: darkColors,
      skills: [{ name: 'only-one', description: 'Only skill', path: '/x', source: 'builtin' as const }],
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('Built-in');
    expect(output).toContain('only-one');
    expect(output).not.toContain('Project');
    expect(output).not.toContain('User');
    expect(output).not.toContain('Extra');
  });
});
