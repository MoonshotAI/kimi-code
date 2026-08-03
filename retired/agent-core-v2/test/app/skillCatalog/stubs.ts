/**
 * `skill` domain test stubs — shared skill fixtures for skill tests.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';

export function stubSkill(
  name: string,
  overrides: Partial<Omit<SkillDefinition, 'name'>> = {},
): SkillDefinition {
  const dir = overrides.dir ?? `/skills/${name}`;
  return {
    name,
    description: overrides.description ?? `desc for ${name}`,
    path: overrides.path ?? `${dir}/SKILL.md`,
    dir,
    content: overrides.content ?? `body of ${name}`,
    metadata: overrides.metadata ?? {},
    source: overrides.source ?? 'user',
    plugin: overrides.plugin,
    mermaid: overrides.mermaid,
    d2: overrides.d2,
  };
}
