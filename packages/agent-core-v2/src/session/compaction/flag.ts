import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const COMPACTION_MODEL_FLAG_ID = 'compaction-model';
export const COMPACTION_MODEL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_COMPACTION_MODEL';

export const compactionModelFlag: FlagDefinitionInput = {
  id: COMPACTION_MODEL_FLAG_ID,
  title: 'Dedicated model for context compaction',
  description:
    'Let context compaction use a separately configured model by default, so a less capable or more expensive conversation model can offload summarization to a dedicated compaction model.',
  env: COMPACTION_MODEL_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(compactionModelFlag);
