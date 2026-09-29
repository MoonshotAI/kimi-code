import { parseSkillText } from '../catalog/parser';
import type { SkillDefinition } from '../catalog/types';

import CHECK_KIMI_CODE_DOCS_BODY from './check-kimi-code-docs.md?raw';
import CUSTOM_THEME_BODY from './custom-theme.md?raw';
import IMPORT_FROM_CC_CODEX_BODY from './import-from-cc-codex.md?raw';
import MCP_CONFIG_BODY from './mcp-config.md?raw';
import CONSOLIDATE_BODY from './sub-skill/consolidate/SKILL.md?raw';
import REVIEW_BODY from './sub-skill/review/SKILL.md?raw';
import PARENT_BODY from './sub-skill/SKILL.md?raw';
import UPDATE_CONFIG_BODY from './update-config.md?raw';
import WRITE_GOAL_BODY from './write-goal.md?raw';

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

function makeBuiltinFile(
  body: string,
  dirName: string,
  pseudoPath: string,
  extraMetadata: Record<string, unknown> = {},
): SkillDefinition {
  const parsed = parseSkillText({
    skillMdPath: `/builtin/skills/${dirName}.md`,
    skillDirName: dirName,
    source: 'builtin',
    text: body,
  });
  return {
    ...parsed,
    path: pseudoPath,
    dir: pseudoPath,
    metadata: {
      ...parsed.metadata,
      type: parsed.metadata.type ?? 'inline',
      ...extraMetadata,
    },
  };
}

export const MCP_CONFIG_SKILL: SkillDefinition = {
  ...makeBuiltinFile(MCP_CONFIG_BODY, 'mcp-config', 'builtin://mcp-config', {
    disableModelInvocation: true,
  }),
  productSpecific: true,
};

export const IMPORT_FROM_CC_CODEX_SKILL: SkillDefinition = {
  ...makeBuiltinFile(IMPORT_FROM_CC_CODEX_BODY, 'import-from-cc-codex', 'builtin://import-from-cc-codex', {
    disableModelInvocation: true,
  }),
  productSpecific: true,
};

export const UPDATE_CONFIG_SKILL: SkillDefinition = {
  ...makeBuiltinFile(UPDATE_CONFIG_BODY, 'update-config', 'builtin://update-config'),
  productSpecific: true,
};

export const CUSTOM_THEME_SKILL: SkillDefinition = {
  ...makeBuiltinFile(CUSTOM_THEME_BODY, 'custom-theme', 'builtin://custom-theme', {
    disableModelInvocation: true,
  }),
  productSpecific: true,
};

export const WRITE_GOAL_SKILL: SkillDefinition = makeBuiltinFile(
  WRITE_GOAL_BODY,
  'write-goal',
  'builtin://write-goal',
);

export const CHECK_KIMI_CODE_DOCS_SKILL: SkillDefinition = {
  ...makeBuiltinFile(
    CHECK_KIMI_CODE_DOCS_BODY,
    'check-kimi-code-docs',
    'builtin://check-kimi-code-docs',
  ),
  productSpecific: true,
};

export const SUB_SKILL_PARENT = makeBuiltin(PARENT_BODY, 'sub-skill', 'builtin://sub-skill', {
  disableModelInvocation: true,
  'has-sub-skill': true,
});

export const SUB_SKILL_REVIEW = makeBuiltin(REVIEW_BODY, 'sub-skill.review', 'builtin://sub-skill/review', {
  disableModelInvocation: true,
  isSubSkill: true,
});

export const SUB_SKILL_CONSOLIDATE = makeBuiltin(
  CONSOLIDATE_BODY,
  'sub-skill.consolidate',
  'builtin://sub-skill/consolidate',
  { disableModelInvocation: true, isSubSkill: true },
);

export const BUILTIN_SKILLS: readonly SkillDefinition[] = [
  MCP_CONFIG_SKILL,
  IMPORT_FROM_CC_CODEX_SKILL,
  UPDATE_CONFIG_SKILL,
  CUSTOM_THEME_SKILL,
  WRITE_GOAL_SKILL,
  CHECK_KIMI_CODE_DOCS_SKILL,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
  SUB_SKILL_CONSOLIDATE,
];

export function visibleBuiltinSkills(
  productSkillsEnabled: boolean,
  experimentalFlagEnabled?: (flag: string) => boolean,
): readonly SkillDefinition[] {
  const visible = productSkillsEnabled
    ? BUILTIN_SKILLS
    : BUILTIN_SKILLS.filter((skill) => skill.productSpecific !== true);
  if (experimentalFlagEnabled === undefined) return visible;
  return visible.filter(
    (skill) =>
      skill.experimentalFlag === undefined || experimentalFlagEnabled(skill.experimentalFlag),
  );
}
