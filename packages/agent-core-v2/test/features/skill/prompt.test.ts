import { describe, expect, it } from 'vitest';

import type { EnvironmentTarget } from '#/environment/environment';
import {
  renderModelToolSkillPrompt,
  renderUserSlashSkillPrompt,
  routedSkillEnvironment,
} from '#/features/skill/prompt';

import { stubSkill } from './catalog/stubs';

describe('renderSkillLoadedBlock skill directory', () => {
  const base = {
    skillName: 'review',
    skillArgs: '',
    skillContent: 'body',
    skillSource: 'user' as const,
    skillDir: '/home/user/.kimi-code/skills/review',
  };

  it('includes the skill directory for model-tool activations', () => {
    const text = renderModelToolSkillPrompt({ ...base, trigger: 'model-tool' });
    expect(text).toContain('dir="/home/user/.kimi-code/skills/review"');
  });

  it('includes the skill directory for nested-skill activations', () => {
    const text = renderModelToolSkillPrompt({ ...base, trigger: 'nested-skill' });
    expect(text).toContain('dir="/home/user/.kimi-code/skills/review"');
  });

  it('includes the skill directory for user-slash activations', () => {
    const text = renderUserSlashSkillPrompt(base);
    expect(text).toContain('dir="/home/user/.kimi-code/skills/review"');
  });

  it('XML-escapes the skill directory', () => {
    const text = renderUserSlashSkillPrompt({
      ...base,
      skillDir: '/skills/a&b/"weird"/<dir>',
    });
    expect(text).toContain('dir="/skills/a&amp;b/&quot;weird&quot;/&lt;dir&gt;"');
    expect(text).not.toContain('dir="/skills/a&b/"weird"/<dir>"');
  });

  it('omits the dir attribute when no directory is supplied', () => {
    const { skillDir: _omit, ...withoutDir } = base;
    const text = renderUserSlashSkillPrompt(withoutDir);
    expect(text).not.toContain('dir=');
    expect(text).toContain('name="review"');
    expect(text).toContain('source="user"');
  });
});

describe('routedSkillEnvironment', () => {
  const remotePrimary: readonly EnvironmentTarget[] = [
    { environmentId: 'devbox', primary: true, cwd: '/srv/app' },
    { environmentId: 'local', primary: false, cwd: '/workspace' },
  ];

  it('names the environment that owns a skill outside the primary environment', () => {
    expect(routedSkillEnvironment(stubSkill('notes', { source: 'user' }), remotePrimary)).toBe('local');
    expect(
      routedSkillEnvironment(stubSkill('deploy@local', { source: 'project', environmentId: 'local' }), remotePrimary),
    ).toBe('local');
  });

  it('omits the environment for primary project skills, builtin skills, and single-environment sessions', () => {
    expect(routedSkillEnvironment(stubSkill('deploy', { source: 'project' }), remotePrimary)).toBeUndefined();
    expect(routedSkillEnvironment(stubSkill('mcp-config', { source: 'builtin' }), remotePrimary)).toBeUndefined();
    expect(routedSkillEnvironment(stubSkill('notes', { source: 'user' }), remotePrimary.slice(0, 1))).toBeUndefined();
  });

  it('renders the owning environment beside the skill directory', () => {
    const text = renderModelToolSkillPrompt({
      skillName: 'deploy@local',
      skillArgs: '',
      skillContent: 'body',
      skillSource: 'project',
      skillEnvironment: 'local',
      skillDir: '/workspace/.agents/skills/deploy',
      trigger: 'model-tool',
    });
    expect(text).toContain('source="project" environment="local" dir="/workspace/.agents/skills/deploy"');
  });
});
