import { describe, expect, it } from 'vitest';

import {
  promptMetadataTextFromBundledSkills,
  promptMetadataTextFromSkill,
  renderModelToolSkillPrompt,
  renderUserSlashSkillPrompt,
} from '#/features/skill/prompt';

describe('skill prompt metadata text', () => {
  it('prefers non-empty display text and keeps redaction for direct activations', () => {
    expect(
      promptMetadataTextFromSkill({
        name: 'review',
        args: 'src',
        clientMetadata: [{ display_text: 'review src\npassword=example-secret' }],
      }),
    ).toBe('review src password=[redacted]');
  });

  it('falls back to the slash command when display text is empty or missing', () => {
    expect(promptMetadataTextFromSkill({ name: 'review' })).toBe('/review');
    expect(promptMetadataTextFromSkill({ name: 'review', args: '  --deep  ' })).toBe('/review --deep');
    expect(
      promptMetadataTextFromSkill({ name: 'review', clientMetadata: [{ display_text: '' }] }),
    ).toBe('/review');
    expect(
      promptMetadataTextFromSkill({
        name: 'review',
        args: 'src',
        clientMetadata: [{ display_text: '   ' }],
      }),
    ).toBe('/review src');
    expect(promptMetadataTextFromSkill({ name: 'review', clientMetadata: [{}] })).toBe('/review');
  });

  it('falls back to skill labels for bundled prompts without usable text', () => {
    expect(
      promptMetadataTextFromBundledSkills({
        input: [{ type: 'text', text: '   ' }],
        skills: [{ name: 'review', args: ' src ' }, { name: 'security' }],
      }),
    ).toBe('/review src /security');
    expect(
      promptMetadataTextFromBundledSkills({
        input: [{ type: 'text', text: '[review](kimi-code://skill/review)' }],
        clientMetadata: [{ display_text: '' }],
        skills: [{ name: 'review' }],
      }),
    ).toBe('/review');
  });

  it('keeps the user text for bundled prompts when present', () => {
    expect(
      promptMetadataTextFromBundledSkills({
        input: [{ type: 'text', text: 'Check this diff' }],
        skills: [{ name: 'review' }],
      }),
    ).toBe('Check this diff');
    expect(
      promptMetadataTextFromBundledSkills({
        input: [{ type: 'text', text: 'Check this diff' }],
        clientMetadata: [{ display_text: 'review this diff' }],
        skills: [{ name: 'review' }],
      }),
    ).toBe('review this diff');
  });
});

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
