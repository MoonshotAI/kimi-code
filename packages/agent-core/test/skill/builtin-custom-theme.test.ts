import { describe, expect, it } from 'vitest';

import { CUSTOM_THEME_SKILL, SessionSkillRegistry, registerBuiltinSkills } from '../../src/skill';

describe('builtin skill: custom-theme', () => {
  it('has the expected identity and inline metadata', () => {
    expect(CUSTOM_THEME_SKILL.name).toBe('custom-theme');
    expect(CUSTOM_THEME_SKILL.source).toBe('builtin');
    expect(CUSTOM_THEME_SKILL.description.length).toBeGreaterThan(0);
    expect(CUSTOM_THEME_SKILL.metadata.type).toBe('inline');
  });

  it('is user-triggered only and hidden from model invocation', () => {
    expect(CUSTOM_THEME_SKILL.metadata.disableModelInvocation).toBe(true);
  });

  it('pins the docs token reference and points users at KIMI_CODE_HOME/themes and /theme', () => {
    const content = CUSTOM_THEME_SKILL.content;
    expect(content).toContain('customization/themes.html');
    expect(content).toContain('FetchURL');
    expect(content).toContain('<KIMI_CODE_HOME>/themes');
    expect(content).toContain('/theme');
    // every documented token should be named so the model knows the full set
    for (const token of [
      'primary',
      'accent',
      'text',
      'textStrong',
      'textDim',
      'textMuted',
      'border',
      'borderFocus',
      'success',
      'warning',
      'error',
      'diffAdded',
      'diffRemoved',
      'diffAddedStrong',
      'diffRemovedStrong',
      'diffGutter',
      'diffMeta',
      'roleUser',
    ]) {
      expect(content).toContain(`\`${token}\``);
    }
  });

  it('registers through registerBuiltinSkills but stays out of the model skill listing', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);

    expect(registry.getSkill('custom-theme')).toBeDefined();
    expect(
      registry.listInvocableSkills().some((skill) => skill.name === 'custom-theme'),
    ).toBe(false);
    expect(registry.getKimiSkillsDescription()).toContain('custom-theme');
    expect(registry.getModelSkillListing()).not.toContain('custom-theme');
  });
});
