import type { SkillDefinition } from '#/app/skillCatalog/types';

const _builtinSkillContributions: SkillDefinition[] = [];

export function registerBuiltinSkill(skill: SkillDefinition): void {
  const existingIndex = _builtinSkillContributions.findIndex(
    (candidate) => candidate.name === skill.name,
  );
  if (existingIndex >= 0) {
    _builtinSkillContributions.splice(existingIndex, 1);
  }
  _builtinSkillContributions.push(skill);
}

export function getBuiltinSkillContributions(): readonly SkillDefinition[] {
  return _builtinSkillContributions;
}

export function _clearBuiltinSkillContributionsForTests(): void {
  _builtinSkillContributions.length = 0;
}
