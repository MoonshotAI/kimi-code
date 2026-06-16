import { describe, expect, it } from 'vitest';

import { SessionSkillRegistry, UPDATE_CONFIG_SKILL, registerBuiltinSkills } from '../../src/skill';

describe('builtin skill: update-config', () => {
  it('has the expected identity and inline metadata', () => {
    expect(UPDATE_CONFIG_SKILL.name).toBe('update-config');
    expect(UPDATE_CONFIG_SKILL.source).toBe('builtin');
    expect(UPDATE_CONFIG_SKILL.description.length).toBeGreaterThan(0);
    expect(UPDATE_CONFIG_SKILL.metadata.type).toBe('inline');
  });

  it('is model-invocable (does not disable model invocation)', () => {
    expect(UPDATE_CONFIG_SKILL.metadata.disableModelInvocation).not.toBe(true);
  });

  it('pins the doc URL as the single source of truth and references TOML / FetchURL / /reload', () => {
    const content = UPDATE_CONFIG_SKILL.content;
    expect(content).toContain('config-files.html');
    expect(content).toContain('FetchURL');
    expect(content).toContain('/reload');
    expect(content.toLowerCase()).toContain('toml');
  });

  it('registers through registerBuiltinSkills and shows up as model-invocable', () => {
    const registry = new SessionSkillRegistry();
    registerBuiltinSkills(registry);

    expect(registry.getSkill('update-config')).toBeDefined();
    expect(
      registry.listInvocableSkills().some((skill) => skill.name === 'update-config'),
    ).toBe(true);
  });
});
