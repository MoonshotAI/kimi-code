/**
 * `skillCatalog` domain (L3) — builtin `languages` skill bundle.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';

import LANGUAGES_BODY from './languages/SKILL.md?raw';
import LANGUAGES_CPP_PRO_BODY from './languages/cpp-pro/SKILL.md?raw';
import LANGUAGES_GOLANG_PRO_BODY from './languages/golang-pro/SKILL.md?raw';
import LANGUAGES_JAVASCRIPT_PRO_BODY from './languages/javascript-pro/SKILL.md?raw';
import LANGUAGES_KOTLIN_SPECIALIST_BODY from './languages/kotlin-specialist/SKILL.md?raw';
import LANGUAGES_PYTHON_EXPERT_BODY from './languages/python-expert/SKILL.md?raw';
import LANGUAGES_PYTHON_PRO_BODY from './languages/python-pro/SKILL.md?raw';
import LANGUAGES_RUST_ENGINEER_BODY from './languages/rust-engineer/SKILL.md?raw';
import LANGUAGES_TYPESCRIPT_PRO_BODY from './languages/typescript-pro/SKILL.md?raw';

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
      ...extraMetadata,
    },
  };
}

export const LANGUAGES_SKILL = makeBuiltin(
  LANGUAGES_BODY,
  'languages',
  'builtin://languages',
  { 'has-sub-skill': true },
);

export const LANGUAGES_CPP_PRO_SKILL = makeBuiltin(
  LANGUAGES_CPP_PRO_BODY,
  'languages.cpp-pro',
  'builtin://languages/cpp-pro',
  { isSubSkill: true },
);

export const LANGUAGES_GOLANG_PRO_SKILL = makeBuiltin(
  LANGUAGES_GOLANG_PRO_BODY,
  'languages.golang-pro',
  'builtin://languages/golang-pro',
  { isSubSkill: true },
);

export const LANGUAGES_JAVASCRIPT_PRO_SKILL = makeBuiltin(
  LANGUAGES_JAVASCRIPT_PRO_BODY,
  'languages.javascript-pro',
  'builtin://languages/javascript-pro',
  { isSubSkill: true },
);

export const LANGUAGES_KOTLIN_SPECIALIST_SKILL = makeBuiltin(
  LANGUAGES_KOTLIN_SPECIALIST_BODY,
  'languages.kotlin-specialist',
  'builtin://languages/kotlin-specialist',
  { isSubSkill: true },
);

export const LANGUAGES_PYTHON_EXPERT_SKILL = makeBuiltin(
  LANGUAGES_PYTHON_EXPERT_BODY,
  'languages.python-expert',
  'builtin://languages/python-expert',
  { isSubSkill: true },
);

export const LANGUAGES_PYTHON_PRO_SKILL = makeBuiltin(
  LANGUAGES_PYTHON_PRO_BODY,
  'languages.python-pro',
  'builtin://languages/python-pro',
  { isSubSkill: true },
);

export const LANGUAGES_RUST_ENGINEER_SKILL = makeBuiltin(
  LANGUAGES_RUST_ENGINEER_BODY,
  'languages.rust-engineer',
  'builtin://languages/rust-engineer',
  { isSubSkill: true },
);

export const LANGUAGES_TYPESCRIPT_PRO_SKILL = makeBuiltin(
  LANGUAGES_TYPESCRIPT_PRO_BODY,
  'languages.typescript-pro',
  'builtin://languages/typescript-pro',
  { isSubSkill: true },
);

