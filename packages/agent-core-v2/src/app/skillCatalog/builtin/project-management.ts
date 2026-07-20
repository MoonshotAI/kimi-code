/**
 * `skillCatalog` domain (L3) — builtin `project-management` skill bundle.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';

import PROJECT_MANAGEMENT_BODY from './project-management/SKILL.md?raw';
import PROJECT_MANAGEMENT_ATLASSIAN_MCP_BODY from './project-management/atlassian-mcp/SKILL.md?raw';
import PROJECT_MANAGEMENT_ATLASSIAN_MCP_REFERENCES_AUTHENTICATION_PATTERNS from './project-management/atlassian-mcp/references/authentication-patterns.md?raw';
import PROJECT_MANAGEMENT_ATLASSIAN_MCP_REFERENCES_COMMON_WORKFLOWS from './project-management/atlassian-mcp/references/common-workflows.md?raw';
import PROJECT_MANAGEMENT_ATLASSIAN_MCP_REFERENCES_CONFLUENCE_OPERATIONS from './project-management/atlassian-mcp/references/confluence-operations.md?raw';
import PROJECT_MANAGEMENT_ATLASSIAN_MCP_REFERENCES_JIRA_QUERIES from './project-management/atlassian-mcp/references/jira-queries.md?raw';
import PROJECT_MANAGEMENT_ATLASSIAN_MCP_REFERENCES_MCP_SERVER_SETUP from './project-management/atlassian-mcp/references/mcp-server-setup.md?raw';
import PROJECT_MANAGEMENT_DECISION_HELPER_BODY from './project-management/decision-helper/SKILL.md?raw';
import PROJECT_MANAGEMENT_FEATURE_FORGE_BODY from './project-management/feature-forge/SKILL.md?raw';
import PROJECT_MANAGEMENT_FEATURE_FORGE_REFERENCES_ACCEPTANCE_CRITERIA from './project-management/feature-forge/references/acceptance-criteria.md?raw';
import PROJECT_MANAGEMENT_FEATURE_FORGE_REFERENCES_EARS_SYNTAX from './project-management/feature-forge/references/ears-syntax.md?raw';
import PROJECT_MANAGEMENT_FEATURE_FORGE_REFERENCES_INTERVIEW_QUESTIONS from './project-management/feature-forge/references/interview-questions.md?raw';
import PROJECT_MANAGEMENT_FEATURE_FORGE_REFERENCES_PRE_DISCOVERY_SUBAGENTS from './project-management/feature-forge/references/pre-discovery-subagents.md?raw';
import PROJECT_MANAGEMENT_FEATURE_FORGE_REFERENCES_SPECIFICATION_TEMPLATE from './project-management/feature-forge/references/specification-template.md?raw';
import PROJECT_MANAGEMENT_PROJECT_PLANNER_BODY from './project-management/project-planner/SKILL.md?raw';
import PROJECT_MANAGEMENT_SPRINT_PLANNER_BODY from './project-management/sprint-planner/SKILL.md?raw';
import PROJECT_MANAGEMENT_STRATEGY_ADVISOR_BODY from './project-management/strategy-advisor/SKILL.md?raw';
import PROJECT_MANAGEMENT_THE_FOOL_BODY from './project-management/the-fool/SKILL.md?raw';
import PROJECT_MANAGEMENT_THE_FOOL_REFERENCES_DIALECTIC_SYNTHESIS from './project-management/the-fool/references/dialectic-synthesis.md?raw';
import PROJECT_MANAGEMENT_THE_FOOL_REFERENCES_EVIDENCE_AUDIT from './project-management/the-fool/references/evidence-audit.md?raw';
import PROJECT_MANAGEMENT_THE_FOOL_REFERENCES_MODE_SELECTION_GUIDE from './project-management/the-fool/references/mode-selection-guide.md?raw';
import PROJECT_MANAGEMENT_THE_FOOL_REFERENCES_PRE_MORTEM_ANALYSIS from './project-management/the-fool/references/pre-mortem-analysis.md?raw';
import PROJECT_MANAGEMENT_THE_FOOL_REFERENCES_RED_TEAM_ADVERSARIAL from './project-management/the-fool/references/red-team-adversarial.md?raw';
import PROJECT_MANAGEMENT_THE_FOOL_REFERENCES_SOCRATIC_QUESTIONING from './project-management/the-fool/references/socratic-questioning.md?raw';

function makeBuiltin(
  body: string,
  dirName: string,
  pseudoPath: string,
  extraMetadata: Record<string, unknown> = {},
  resources?: Readonly<Record<string, string>>,
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
    resources,
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
  {
    'references/authentication-patterns.md': PROJECT_MANAGEMENT_ATLASSIAN_MCP_REFERENCES_AUTHENTICATION_PATTERNS,
    'references/common-workflows.md': PROJECT_MANAGEMENT_ATLASSIAN_MCP_REFERENCES_COMMON_WORKFLOWS,
    'references/confluence-operations.md': PROJECT_MANAGEMENT_ATLASSIAN_MCP_REFERENCES_CONFLUENCE_OPERATIONS,
    'references/jira-queries.md': PROJECT_MANAGEMENT_ATLASSIAN_MCP_REFERENCES_JIRA_QUERIES,
    'references/mcp-server-setup.md': PROJECT_MANAGEMENT_ATLASSIAN_MCP_REFERENCES_MCP_SERVER_SETUP,
  },
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
  {
    'references/acceptance-criteria.md': PROJECT_MANAGEMENT_FEATURE_FORGE_REFERENCES_ACCEPTANCE_CRITERIA,
    'references/ears-syntax.md': PROJECT_MANAGEMENT_FEATURE_FORGE_REFERENCES_EARS_SYNTAX,
    'references/interview-questions.md': PROJECT_MANAGEMENT_FEATURE_FORGE_REFERENCES_INTERVIEW_QUESTIONS,
    'references/pre-discovery-subagents.md': PROJECT_MANAGEMENT_FEATURE_FORGE_REFERENCES_PRE_DISCOVERY_SUBAGENTS,
    'references/specification-template.md': PROJECT_MANAGEMENT_FEATURE_FORGE_REFERENCES_SPECIFICATION_TEMPLATE,
  },
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
  {
    'references/dialectic-synthesis.md': PROJECT_MANAGEMENT_THE_FOOL_REFERENCES_DIALECTIC_SYNTHESIS,
    'references/evidence-audit.md': PROJECT_MANAGEMENT_THE_FOOL_REFERENCES_EVIDENCE_AUDIT,
    'references/mode-selection-guide.md': PROJECT_MANAGEMENT_THE_FOOL_REFERENCES_MODE_SELECTION_GUIDE,
    'references/pre-mortem-analysis.md': PROJECT_MANAGEMENT_THE_FOOL_REFERENCES_PRE_MORTEM_ANALYSIS,
    'references/red-team-adversarial.md': PROJECT_MANAGEMENT_THE_FOOL_REFERENCES_RED_TEAM_ADVERSARIAL,
    'references/socratic-questioning.md': PROJECT_MANAGEMENT_THE_FOOL_REFERENCES_SOCRATIC_QUESTIONING,
  },
);

