import { describe, expect, it } from 'vitest';

import {
  renderModelToolSkillPrompt,
  renderUserSlashSkillPrompt,
} from '#/agent/skill/prompt';

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
