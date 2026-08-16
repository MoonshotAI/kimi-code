import { describe, expect, it } from 'vitest';

import {
  isInlineSkillType,
  isSupportedSkillType,
  isUserActivatableSkillType,
  normalizeSkillName,
  summarizeSkill,
} from '#/features/skill/catalog/types';
import type { SkillDefinition } from '#/features/skill/catalog/types';

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

  it('summarizeSkill projects optional category, issuer, collection, groups, tags', () => {
    const skill: SkillDefinition = {
      name: 'cv_ssh-ops',
      description: 'SSH ops',
      path: '/skills/cv_ssh-ops',
      source: 'user',
      metadata: {
        type: 'prompt',
        category: 'ops',
        issuer: 'creatiVision',
        collection: 'cv-infrastructure',
        groups: ['cv', 'cv/ops'],
        tags: ['cv', 'ssh'],
      },
    } as SkillDefinition;
    expect(summarizeSkill(skill)).toEqual({
      name: 'cv_ssh-ops',
      description: 'SSH ops',
      path: '/skills/cv_ssh-ops',
      source: 'user',
      type: 'prompt',
      category: 'ops',
      issuer: 'creatiVision',
      collection: 'cv-infrastructure',
      groups: ['cv', 'cv/ops'],
      tags: ['cv', 'ssh'],
    });
  });
});
