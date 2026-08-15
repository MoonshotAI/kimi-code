/**
 * `skillCatalog` domain — module-level builtin-skill contribution registry.
 *
 * Feature-authored builtin skills contribute themselves at module load via
 * `registerBuiltinSkill(skill)` — the same "import = register" pattern used
 * by `registerAgentToolService` for agent tools and `registerAgentProfile`
 * for agent profiles. `visibleBuiltinSkills` folds these with the
 * code-defined `BUILTIN_SKILLS`, so a feature (e.g. tower) ships its builtin
 * skill without editing the builtin module. Uniqueness is enforced by
 * `name`: later registrations replace earlier ones, so tests can override a
 * built-in by re-registering.
 */

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
