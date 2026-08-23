import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

/**
 * `compaction` domain — registers the `compaction-model` experimental flag
 * into `flag`.
 *
 * Compaction-model mirror of {@link visualModelFlag}: gates dedicated-model
 * selection for context compaction. When this experiment is enabled and
 * `[compaction_model]` is configured, the full-compaction routine asks a
 * separately configured model to summarize/compact context instead of using
 * the active conversation model. When unset, behavior is unchanged (compaction
 * inherits the caller's model). If the dedicated model errors or is
 * inaccessible, compaction transparently falls back to the current model.
 */
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
