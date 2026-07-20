import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import AI_ML_BODY from './ai-ml/SKILL.md?raw';
import AI_ML_FINE_TUNING_EXPERT_BODY from './ai-ml/fine-tuning-expert/SKILL.md?raw';
import AI_ML_MCP_DEVELOPER_BODY from './ai-ml/mcp-developer/SKILL.md?raw';
import AI_ML_ML_PIPELINE_BODY from './ai-ml/ml-pipeline/SKILL.md?raw';
import AI_ML_PROMPT_ENGINEER_BODY from './ai-ml/prompt-engineer/SKILL.md?raw';
import AI_ML_RAG_ARCHITECT_BODY from './ai-ml/rag-architect/SKILL.md?raw';

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

export const AI_ML_SKILL = makeBuiltin(
  AI_ML_BODY,
  'ai-ml',
  'builtin://ai-ml',
  { 'has-sub-skill': true },
);

export const AI_ML_FINE_TUNING_EXPERT_SKILL = makeBuiltin(
  AI_ML_FINE_TUNING_EXPERT_BODY,
  'ai-ml.fine-tuning-expert',
  'builtin://ai-ml/fine-tuning-expert',
  { isSubSkill: true },
);

export const AI_ML_MCP_DEVELOPER_SKILL = makeBuiltin(
  AI_ML_MCP_DEVELOPER_BODY,
  'ai-ml.mcp-developer',
  'builtin://ai-ml/mcp-developer',
  { isSubSkill: true },
);

export const AI_ML_ML_PIPELINE_SKILL = makeBuiltin(
  AI_ML_ML_PIPELINE_BODY,
  'ai-ml.ml-pipeline',
  'builtin://ai-ml/ml-pipeline',
  { isSubSkill: true },
);

export const AI_ML_PROMPT_ENGINEER_SKILL = makeBuiltin(
  AI_ML_PROMPT_ENGINEER_BODY,
  'ai-ml.prompt-engineer',
  'builtin://ai-ml/prompt-engineer',
  { isSubSkill: true },
);

export const AI_ML_RAG_ARCHITECT_SKILL = makeBuiltin(
  AI_ML_RAG_ARCHITECT_BODY,
  'ai-ml.rag-architect',
  'builtin://ai-ml/rag-architect',
  { isSubSkill: true },
);

