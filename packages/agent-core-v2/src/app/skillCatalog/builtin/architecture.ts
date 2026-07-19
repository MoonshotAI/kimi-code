/**
 * `skillCatalog` domain (L3) — builtin `architecture` skill bundle.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';

import ARCHITECTURE_BODY from './architecture/SKILL.md?raw';
import ARCHITECTURE_API_DESIGNER_BODY from './architecture/api-designer/SKILL.md?raw';
import ARCHITECTURE_ARCHITECTURE_DESIGNER_BODY from './architecture/architecture-designer/SKILL.md?raw';
import ARCHITECTURE_GRAPHQL_ARCHITECT_BODY from './architecture/graphql-architect/SKILL.md?raw';
import ARCHITECTURE_LEGACY_MODERNIZER_BODY from './architecture/legacy-modernizer/SKILL.md?raw';
import ARCHITECTURE_MICROSERVICES_ARCHITECT_BODY from './architecture/microservices-architect/SKILL.md?raw';
import ARCHITECTURE_SPEC_MINER_BODY from './architecture/spec-miner/SKILL.md?raw';

function makeBuiltin(
  body: string,
  dirName: string,
  pseudoPath: string,
  extraMetadata: Record<string, unknown> = {},
): SkillDefinition {
  const parsed = parseSkillText({
    skillMdPath: `/builtin/skills/${dirName}/SKILL.md`,
    skillDirName: dirName,
    source: 'builtin',
    text: body,
  });
  return {
    ...parsed,
    name: dirName,
    path: pseudoPath,
    dir: pseudoPath,
    metadata: {
      ...parsed.metadata,
      type: parsed.metadata.type ?? 'inline',
      disableModelInvocation: true,
      ...extraMetadata,
    },
  };
}

export const ARCHITECTURE_SKILL = makeBuiltin(
  ARCHITECTURE_BODY,
  'architecture',
  'builtin://architecture',
  { 'has-sub-skill': true },
);

export const ARCHITECTURE_API_DESIGNER_SKILL = makeBuiltin(
  ARCHITECTURE_API_DESIGNER_BODY,
  'architecture.api-designer',
  'builtin://architecture/api-designer',
  { isSubSkill: true },
);

export const ARCHITECTURE_ARCHITECTURE_DESIGNER_SKILL = makeBuiltin(
  ARCHITECTURE_ARCHITECTURE_DESIGNER_BODY,
  'architecture.architecture-designer',
  'builtin://architecture/architecture-designer',
  { isSubSkill: true },
);

export const ARCHITECTURE_GRAPHQL_ARCHITECT_SKILL = makeBuiltin(
  ARCHITECTURE_GRAPHQL_ARCHITECT_BODY,
  'architecture.graphql-architect',
  'builtin://architecture/graphql-architect',
  { isSubSkill: true },
);

export const ARCHITECTURE_LEGACY_MODERNIZER_SKILL = makeBuiltin(
  ARCHITECTURE_LEGACY_MODERNIZER_BODY,
  'architecture.legacy-modernizer',
  'builtin://architecture/legacy-modernizer',
  { isSubSkill: true },
);

export const ARCHITECTURE_MICROSERVICES_ARCHITECT_SKILL = makeBuiltin(
  ARCHITECTURE_MICROSERVICES_ARCHITECT_BODY,
  'architecture.microservices-architect',
  'builtin://architecture/microservices-architect',
  { isSubSkill: true },
);

export const ARCHITECTURE_SPEC_MINER_SKILL = makeBuiltin(
  ARCHITECTURE_SPEC_MINER_BODY,
  'architecture.spec-miner',
  'builtin://architecture/spec-miner',
  { isSubSkill: true },
);

