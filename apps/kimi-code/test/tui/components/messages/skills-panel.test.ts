import type { SkillSummary } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { buildSkillsReportLines } from '#/tui/components/messages/skills-panel';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function skill(input: {
  readonly name: string;
  readonly source: SkillSummary['source'];
  readonly description?: string;
  readonly type?: string;
  readonly disableModelInvocation?: boolean;
}): SkillSummary {
  return {
    name: input.name,
    description: input.description ?? `${input.name} description`,
    path: `/skills/${input.name}/SKILL.md`,
    source: input.source,
    type: input.type,
    disableModelInvocation: input.disableModelInvocation,
  };
}

describe('skills panel report lines', () => {
  it('groups loaded skills and shows paths, types, descriptions, and manual-only state', () => {
    const lines = buildSkillsReportLines({
      colors: darkColors,
      workDir: '/workspace/project',
      skills: [
        skill({
          name: 'mcp-config',
          source: 'builtin',
          type: 'inline',
          disableModelInvocation: true,
        }),
        skill({ name: 'review', source: 'project', type: 'prompt' }),
        skill({ name: 'deploy', source: 'user', type: 'flow', description: 'Deploy the app' }),
      ],
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('Project');
    expect(output).toContain('review  type: prompt');
    expect(output).toContain('path: /skills/review/SKILL.md');
    expect(output).toContain('User');
    expect(output).toContain('deploy  type: flow');
    expect(output).toContain('Deploy the app');
    expect(output).toContain('Built-in');
    expect(output).toContain('mcp-config  type: inline | manual only');
    expect(output).not.toContain('command:');
  });

  it('renders skills without an explicit type as prompt skills', () => {
    const lines = buildSkillsReportLines({
      colors: darkColors,
      workDir: '/workspace/project',
      skills: [skill({ name: 'review', source: 'project' })],
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('review  type: prompt');
  });

  it('renders the empty loaded skills state', () => {
    const lines = buildSkillsReportLines({
      colors: darkColors,
      skills: [],
      workDir: '/workspace/project',
    }).map(strip);

    expect(lines).toContain('Skills');
    expect(lines).toContain('  No skills loaded for this session.');
  });

  it('renders paths under the current workdir as relative paths', () => {
    const lines = buildSkillsReportLines({
      colors: darkColors,
      workDir: '/workspace/project',
      skills: [
        {
          ...skill({ name: 'local', source: 'project', type: 'prompt' }),
          path: '/workspace/project/.agents/skills/local/SKILL.md',
        },
        {
          ...skill({ name: 'external', source: 'extra', type: 'prompt' }),
          path: '/workspace/shared/external/SKILL.md',
        },
      ],
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('path: .agents/skills/local/SKILL.md');
    expect(output).toContain('path: /workspace/shared/external/SKILL.md');
  });
});
