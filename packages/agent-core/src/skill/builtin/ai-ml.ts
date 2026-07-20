import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import AI_ML_BODY from './ai-ml/SKILL.md?raw';
import AI_ML_FINE_TUNING_EXPERT_BODY from './ai-ml/fine-tuning-expert/SKILL.md?raw';
import AI_ML_FINE_TUNING_EXPERT_REFERENCES_DATASET_PREPARATION from './ai-ml/fine-tuning-expert/references/dataset-preparation.md?raw';
import AI_ML_FINE_TUNING_EXPERT_REFERENCES_DEPLOYMENT_OPTIMIZATION from './ai-ml/fine-tuning-expert/references/deployment-optimization.md?raw';
import AI_ML_FINE_TUNING_EXPERT_REFERENCES_EVALUATION_METRICS from './ai-ml/fine-tuning-expert/references/evaluation-metrics.md?raw';
import AI_ML_FINE_TUNING_EXPERT_REFERENCES_HYPERPARAMETER_TUNING from './ai-ml/fine-tuning-expert/references/hyperparameter-tuning.md?raw';
import AI_ML_FINE_TUNING_EXPERT_REFERENCES_LORA_PEFT from './ai-ml/fine-tuning-expert/references/lora-peft.md?raw';
import AI_ML_MCP_DEVELOPER_BODY from './ai-ml/mcp-developer/SKILL.md?raw';
import AI_ML_MCP_DEVELOPER_REFERENCES_PROTOCOL from './ai-ml/mcp-developer/references/protocol.md?raw';
import AI_ML_MCP_DEVELOPER_REFERENCES_PYTHON_SDK from './ai-ml/mcp-developer/references/python-sdk.md?raw';
import AI_ML_MCP_DEVELOPER_REFERENCES_RESOURCES from './ai-ml/mcp-developer/references/resources.md?raw';
import AI_ML_MCP_DEVELOPER_REFERENCES_TOOLS from './ai-ml/mcp-developer/references/tools.md?raw';
import AI_ML_MCP_DEVELOPER_REFERENCES_TYPESCRIPT_SDK from './ai-ml/mcp-developer/references/typescript-sdk.md?raw';
import AI_ML_ML_PIPELINE_BODY from './ai-ml/ml-pipeline/SKILL.md?raw';
import AI_ML_ML_PIPELINE_REFERENCES_EXPERIMENT_TRACKING from './ai-ml/ml-pipeline/references/experiment-tracking.md?raw';
import AI_ML_ML_PIPELINE_REFERENCES_FEATURE_ENGINEERING from './ai-ml/ml-pipeline/references/feature-engineering.md?raw';
import AI_ML_ML_PIPELINE_REFERENCES_MODEL_VALIDATION from './ai-ml/ml-pipeline/references/model-validation.md?raw';
import AI_ML_ML_PIPELINE_REFERENCES_PIPELINE_ORCHESTRATION from './ai-ml/ml-pipeline/references/pipeline-orchestration.md?raw';
import AI_ML_ML_PIPELINE_REFERENCES_TRAINING_PIPELINES from './ai-ml/ml-pipeline/references/training-pipelines.md?raw';
import AI_ML_PROMPT_ENGINEER_BODY from './ai-ml/prompt-engineer/SKILL.md?raw';
import AI_ML_PROMPT_ENGINEER_REFERENCES_CONTEXT_MANAGEMENT from './ai-ml/prompt-engineer/references/context-management.md?raw';
import AI_ML_PROMPT_ENGINEER_REFERENCES_EVALUATION_FRAMEWORKS from './ai-ml/prompt-engineer/references/evaluation-frameworks.md?raw';
import AI_ML_PROMPT_ENGINEER_REFERENCES_PROMPT_OPTIMIZATION from './ai-ml/prompt-engineer/references/prompt-optimization.md?raw';
import AI_ML_PROMPT_ENGINEER_REFERENCES_PROMPT_PATTERNS from './ai-ml/prompt-engineer/references/prompt-patterns.md?raw';
import AI_ML_PROMPT_ENGINEER_REFERENCES_STRUCTURED_OUTPUTS from './ai-ml/prompt-engineer/references/structured-outputs.md?raw';
import AI_ML_PROMPT_ENGINEER_REFERENCES_SYSTEM_PROMPTS from './ai-ml/prompt-engineer/references/system-prompts.md?raw';
import AI_ML_RAG_ARCHITECT_BODY from './ai-ml/rag-architect/SKILL.md?raw';
import AI_ML_RAG_ARCHITECT_REFERENCES_CHUNKING_STRATEGIES from './ai-ml/rag-architect/references/chunking-strategies.md?raw';
import AI_ML_RAG_ARCHITECT_REFERENCES_EMBEDDING_MODELS from './ai-ml/rag-architect/references/embedding-models.md?raw';
import AI_ML_RAG_ARCHITECT_REFERENCES_RAG_EVALUATION from './ai-ml/rag-architect/references/rag-evaluation.md?raw';
import AI_ML_RAG_ARCHITECT_REFERENCES_RETRIEVAL_OPTIMIZATION from './ai-ml/rag-architect/references/retrieval-optimization.md?raw';
import AI_ML_RAG_ARCHITECT_REFERENCES_VECTOR_DATABASES from './ai-ml/rag-architect/references/vector-databases.md?raw';

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
  {
    'references/dataset-preparation.md': AI_ML_FINE_TUNING_EXPERT_REFERENCES_DATASET_PREPARATION,
    'references/deployment-optimization.md': AI_ML_FINE_TUNING_EXPERT_REFERENCES_DEPLOYMENT_OPTIMIZATION,
    'references/evaluation-metrics.md': AI_ML_FINE_TUNING_EXPERT_REFERENCES_EVALUATION_METRICS,
    'references/hyperparameter-tuning.md': AI_ML_FINE_TUNING_EXPERT_REFERENCES_HYPERPARAMETER_TUNING,
    'references/lora-peft.md': AI_ML_FINE_TUNING_EXPERT_REFERENCES_LORA_PEFT,
  },
);

export const AI_ML_MCP_DEVELOPER_SKILL = makeBuiltin(
  AI_ML_MCP_DEVELOPER_BODY,
  'ai-ml.mcp-developer',
  'builtin://ai-ml/mcp-developer',
  { isSubSkill: true },
  {
    'references/protocol.md': AI_ML_MCP_DEVELOPER_REFERENCES_PROTOCOL,
    'references/python-sdk.md': AI_ML_MCP_DEVELOPER_REFERENCES_PYTHON_SDK,
    'references/resources.md': AI_ML_MCP_DEVELOPER_REFERENCES_RESOURCES,
    'references/tools.md': AI_ML_MCP_DEVELOPER_REFERENCES_TOOLS,
    'references/typescript-sdk.md': AI_ML_MCP_DEVELOPER_REFERENCES_TYPESCRIPT_SDK,
  },
);

export const AI_ML_ML_PIPELINE_SKILL = makeBuiltin(
  AI_ML_ML_PIPELINE_BODY,
  'ai-ml.ml-pipeline',
  'builtin://ai-ml/ml-pipeline',
  { isSubSkill: true },
  {
    'references/experiment-tracking.md': AI_ML_ML_PIPELINE_REFERENCES_EXPERIMENT_TRACKING,
    'references/feature-engineering.md': AI_ML_ML_PIPELINE_REFERENCES_FEATURE_ENGINEERING,
    'references/model-validation.md': AI_ML_ML_PIPELINE_REFERENCES_MODEL_VALIDATION,
    'references/pipeline-orchestration.md': AI_ML_ML_PIPELINE_REFERENCES_PIPELINE_ORCHESTRATION,
    'references/training-pipelines.md': AI_ML_ML_PIPELINE_REFERENCES_TRAINING_PIPELINES,
  },
);

export const AI_ML_PROMPT_ENGINEER_SKILL = makeBuiltin(
  AI_ML_PROMPT_ENGINEER_BODY,
  'ai-ml.prompt-engineer',
  'builtin://ai-ml/prompt-engineer',
  { isSubSkill: true },
  {
    'references/context-management.md': AI_ML_PROMPT_ENGINEER_REFERENCES_CONTEXT_MANAGEMENT,
    'references/evaluation-frameworks.md': AI_ML_PROMPT_ENGINEER_REFERENCES_EVALUATION_FRAMEWORKS,
    'references/prompt-optimization.md': AI_ML_PROMPT_ENGINEER_REFERENCES_PROMPT_OPTIMIZATION,
    'references/prompt-patterns.md': AI_ML_PROMPT_ENGINEER_REFERENCES_PROMPT_PATTERNS,
    'references/structured-outputs.md': AI_ML_PROMPT_ENGINEER_REFERENCES_STRUCTURED_OUTPUTS,
    'references/system-prompts.md': AI_ML_PROMPT_ENGINEER_REFERENCES_SYSTEM_PROMPTS,
  },
);

export const AI_ML_RAG_ARCHITECT_SKILL = makeBuiltin(
  AI_ML_RAG_ARCHITECT_BODY,
  'ai-ml.rag-architect',
  'builtin://ai-ml/rag-architect',
  { isSubSkill: true },
  {
    'references/chunking-strategies.md': AI_ML_RAG_ARCHITECT_REFERENCES_CHUNKING_STRATEGIES,
    'references/embedding-models.md': AI_ML_RAG_ARCHITECT_REFERENCES_EMBEDDING_MODELS,
    'references/rag-evaluation.md': AI_ML_RAG_ARCHITECT_REFERENCES_RAG_EVALUATION,
    'references/retrieval-optimization.md': AI_ML_RAG_ARCHITECT_REFERENCES_RETRIEVAL_OPTIMIZATION,
    'references/vector-databases.md': AI_ML_RAG_ARCHITECT_REFERENCES_VECTOR_DATABASES,
  },
);
