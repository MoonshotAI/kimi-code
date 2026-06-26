import { describe, expect, it } from 'vitest';

import {
  isInlineSkillType,
  isSupportedSkillType,
  isUserActivatableSkillType,
  normalizeSkillName,
  summarizeSkill,
} from '#/skill/types';
import type { SkillDefinition } from '#/skill/types';

describe('skill/types', () => {
  it('normalizeSkillName lowercases', () => {
    expect(normalizeSkillName('CoMmIt')).toBe('commit');
  });

  it('isInlineSkillType treats undefined/prompt/inline as inline', () => {
    expect(isInlineSkillType(undefined)).toBe(true);
    expect(isInlineSkillType('prompt')).toBe(true);
    expect(isInlineSkillType('inline')).toBe(true);
    expect(isInlineSkillType('flow')).toBe(false);
  });

  it('isUserActivatableSkillType includes flow', () => {
    expect(isUserActivatableSkillType('flow')).toBe(true);
    expect(isUserActivatableSkillType('reference')).toBe(false);
  });

  it('isSupportedSkillType includes reference', () => {
    expect(isSupportedSkillType('reference')).toBe(true);
    expect(isSupportedSkillType('unknown')).toBe(false);
  });

  it('summarizeSkill projects the public fields', () => {
    const skill: SkillDefinition = {
      name: 'commit',
      description: 'Commit helper',
      path: '/skills/commit',
      source: 'user',
      metadata: { type: 'prompt', disableModelInvocation: false, isSubSkill: false },
    } as SkillDefinition;
    expect(summarizeSkill(skill)).toEqual({
      name: 'commit',
      description: 'Commit helper',
      path: '/skills/commit',
      source: 'user',
      type: 'prompt',
      disableModelInvocation: false,
      isSubSkill: false,
    });
  });
});
