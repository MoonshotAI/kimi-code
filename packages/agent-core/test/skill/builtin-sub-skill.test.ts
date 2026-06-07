import { describe, expect, it } from 'vitest';

import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
import {
  SkillRegistry,
  SUB_SKILL_CONSOLIDATE,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
  registerBuiltinSkills,
} from '../../src/skill';

describe('builtin skill: sub-skill', () => {
  it('has the expected identity and inline metadata', () => {
    expect(SUB_SKILL_PARENT.name).toBe('sub-skill');
    expect(SUB_SKILL_PARENT.source).toBe('builtin');
    expect(SUB_SKILL_PARENT.description.length).toBeGreaterThan(0);
    expect(SUB_SKILL_PARENT.metadata.type).toBe('inline');
  });

  it('is hidden from model invocation and marked as a sub-skill', () => {
    expect(SUB_SKILL_PARENT.metadata.disableModelInvocation).toBe(true);
    expect(SUB_SKILL_PARENT.metadata['has-sub-skill']).toBe(true);
  });

  it('registers through registerBuiltinSkills but stays out of the model skill listing', () => {
    const registry = new SkillRegistry();
    registerBuiltinSkills(registry, {
      experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS, { 'sub_skill': true }),
    });

    expect(registry.getSkill('sub-skill')).toBeDefined();
    expect(
      registry.listInvocableSkills().some((skill) => skill.name === 'sub-skill'),
    ).toBe(false);
  });

  it('remains visible in the full skill list for CLI display when enabled', () => {
    const registry = new SkillRegistry();
    registerBuiltinSkills(registry, {
      experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS, { 'sub_skill': true }),
    });

    expect(registry.listSkills().some((skill) => skill.name === 'sub-skill')).toBe(true);
  });

  it('does not register sub-skill builtins when the scoped flag is disabled', () => {
    const registry = new SkillRegistry();
    registerBuiltinSkills(registry, {
      experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS, { 'sub_skill': false }),
    });

    expect(registry.getSkill('sub-skill')).toBeUndefined();
    expect(registry.getSkill('sub-skill.review')).toBeUndefined();
    expect(registry.getSkill('sub-skill.consolidate')).toBeUndefined();
  });
});

describe('builtin skill: sub-skill.review', () => {
  it('has the expected identity and inline metadata', () => {
    expect(SUB_SKILL_REVIEW.name).toBe('sub-skill.review');
    expect(SUB_SKILL_REVIEW.source).toBe('builtin');
    expect(SUB_SKILL_REVIEW.description.length).toBeGreaterThan(0);
    expect(SUB_SKILL_REVIEW.metadata.type).toBe('inline');
  });

  it('is hidden from model invocation', () => {
    expect(SUB_SKILL_REVIEW.metadata.disableModelInvocation).toBe(true);
  });

  it('registers through registerBuiltinSkills', () => {
    const registry = new SkillRegistry();
    registerBuiltinSkills(registry, {
      experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS, { 'sub_skill': true }),
    });

    expect(registry.getSkill('sub-skill.review')).toBeDefined();
    expect(
      registry.listInvocableSkills().some((skill) => skill.name === 'sub-skill.review'),
    ).toBe(false);
  });
});

describe('builtin skill: sub-skill.consolidate', () => {
  it('has the expected identity and inline metadata', () => {
    expect(SUB_SKILL_CONSOLIDATE.name).toBe('sub-skill.consolidate');
    expect(SUB_SKILL_CONSOLIDATE.source).toBe('builtin');
    expect(SUB_SKILL_CONSOLIDATE.description.length).toBeGreaterThan(0);
    expect(SUB_SKILL_CONSOLIDATE.metadata.type).toBe('inline');
  });

  it('is hidden from model invocation', () => {
    expect(SUB_SKILL_CONSOLIDATE.metadata.disableModelInvocation).toBe(true);
  });

  it('mentions backup requirements in its content', () => {
    expect(SUB_SKILL_CONSOLIDATE.content).toContain('back up');
    expect(SUB_SKILL_CONSOLIDATE.content).toContain('timestamped');
  });

  it('registers through registerBuiltinSkills', () => {
    const registry = new SkillRegistry();
    registerBuiltinSkills(registry, {
      experimentalFlags: new FlagResolver({}, FLAG_DEFINITIONS, { 'sub_skill': true }),
    });

    expect(registry.getSkill('sub-skill.consolidate')).toBeDefined();
    expect(
      registry.listInvocableSkills().some((skill) => skill.name === 'sub-skill.consolidate'),
    ).toBe(false);
  });
});
