import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import PROJECT_MANAGEMENT_BODY from './project-management/SKILL.md?raw';
import PROJECT_MANAGEMENT_ATLASSIAN_MCP_BODY from './project-management/atlassian-mcp/SKILL.md?raw';
import PROJECT_MANAGEMENT_DECISION_HELPER_BODY from './project-management/decision-helper/SKILL.md?raw';
import PROJECT_MANAGEMENT_FEATURE_FORGE_BODY from './project-management/feature-forge/SKILL.md?raw';
import PROJECT_MANAGEMENT_PROJECT_PLANNER_BODY from './project-management/project-planner/SKILL.md?raw';
import PROJECT_MANAGEMENT_SPRINT_PLANNER_BODY from './project-management/sprint-planner/SKILL.md?raw';
import PROJECT_MANAGEMENT_STRATEGY_ADVISOR_BODY from './project-management/strategy-advisor/SKILL.md?raw';
import PROJECT_MANAGEMENT_THE_FOOL_BODY from './project-management/the-fool/SKILL.md?raw';

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

export const PROJECT_MANAGEMENT_SKILL = makeBuiltin(
  PROJECT_MANAGEMENT_BODY,
  'project-management',
  'builtin://project-management',
  { 'has-sub-skill': true },
);

export const PROJECT_MANAGEMENT_ATLASSIAN_MCP_SKILL = makeBuiltin(
  PROJECT_MANAGEMENT_ATLASSIAN_MCP_BODY,
  'project-management.atlassian-mcp',
  'builtin://project-management/atlassian-mcp',
  { isSubSkill: true },
);

export const PROJECT_MANAGEMENT_DECISION_HELPER_SKILL = makeBuiltin(
  PROJECT_MANAGEMENT_DECISION_HELPER_BODY,
  'project-management.decision-helper',
  'builtin://project-management/decision-helper',
  { isSubSkill: true },
);

export const PROJECT_MANAGEMENT_FEATURE_FORGE_SKILL = makeBuiltin(
  PROJECT_MANAGEMENT_FEATURE_FORGE_BODY,
  'project-management.feature-forge',
  'builtin://project-management/feature-forge',
  { isSubSkill: true },
);

export const PROJECT_MANAGEMENT_PROJECT_PLANNER_SKILL = makeBuiltin(
  PROJECT_MANAGEMENT_PROJECT_PLANNER_BODY,
  'project-management.project-planner',
  'builtin://project-management/project-planner',
  { isSubSkill: true },
);

export const PROJECT_MANAGEMENT_SPRINT_PLANNER_SKILL = makeBuiltin(
  PROJECT_MANAGEMENT_SPRINT_PLANNER_BODY,
  'project-management.sprint-planner',
  'builtin://project-management/sprint-planner',
  { isSubSkill: true },
);

export const PROJECT_MANAGEMENT_STRATEGY_ADVISOR_SKILL = makeBuiltin(
  PROJECT_MANAGEMENT_STRATEGY_ADVISOR_BODY,
  'project-management.strategy-advisor',
  'builtin://project-management/strategy-advisor',
  { isSubSkill: true },
);

export const PROJECT_MANAGEMENT_THE_FOOL_SKILL = makeBuiltin(
  PROJECT_MANAGEMENT_THE_FOOL_BODY,
  'project-management.the-fool',
  'builtin://project-management/the-fool',
  { isSubSkill: true },
);

