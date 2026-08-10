import type { SkillDiscoveryReport } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  formatSkillsReport,
  handleSkillsList,
  type SkillsListDeps,
} from '#/cli/sub/skills';

const REPORT: SkillDiscoveryReport = {
  skills: [
    {
      name: 'review',
      description: 'Review a change',
      path: '/repo/.agents/skills/review/SKILL.md',
      source: 'project',
      type: 'prompt',
    },
    {
      name: 'reference-only',
      description: 'Reference material',
      path: '/repo/.agents/skills/reference-only/SKILL.md',
      source: 'project',
      type: 'reference',
    },
  ],
  diagnostics: [
    {
      path: '/repo/.agents/skills/broken/SKILL.md',
      type: 'invalid',
      reason: 'Missing frontmatter',
    },
  ],
};

function makeDeps() {
  let stdout = '';
  let stderr = '';
  const deps: SkillsListDeps = {
    cwd: () => '/repo',
    inspectWorkspaceSkills: vi.fn(async () => REPORT),
    stdout: { write: (chunk) => { stdout += chunk; return true; } },
    stderr: { write: (chunk) => { stderr += chunk; return true; } },
    exit: (code) => { throw new Error(`exit ${String(code)}`); },
    close: vi.fn(async () => {}),
  };
  return { deps, stdout: () => stdout, stderr: () => stderr };
}

describe('skills list CLI', () => {
  it('formats loaded skills, effective slash commands, paths, and diagnostics', () => {
    const text = formatSkillsReport(REPORT);

    expect(text).toContain('2 skills loaded.');
    expect(text).toContain('/skill:review  review  [project · prompt]');
    expect(text).toContain('not slash-invocable  reference-only');
    expect(text).toContain('/repo/.agents/skills/review/SKILL.md');
    expect(text).toContain('1 discovery issue:');
    expect(text).toContain('[invalid] /repo/.agents/skills/broken/SKILL.md: Missing frontmatter');
  });

  it('emits a stable JSON report with nullable slash commands', async () => {
    const { deps, stdout } = makeDeps();

    await handleSkillsList(deps, { json: true });

    expect(deps.inspectWorkspaceSkills).toHaveBeenCalledWith('/repo');
    expect(JSON.parse(stdout())).toEqual({
      skills: [
        { ...REPORT.skills[0], slashCommand: 'skill:review' },
        { ...REPORT.skills[1], slashCommand: null },
      ],
      diagnostics: REPORT.diagnostics,
    });
  });
});
