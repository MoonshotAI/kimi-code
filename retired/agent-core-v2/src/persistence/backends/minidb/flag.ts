/**
 * `minidb` persistence backend — flag contribution.
 *
 * Gates the minidb-backed derived read-model (`IQueryStore`) and the consumers
 * that read through it. Off by default; enable via
 * `KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL` or the `[experimental]`
 * config section. Imported for its side effect (registers the definition) from
 * the backend barrel.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const persistenceMiniDbReadModelFlag: FlagDefinitionInput = {
  id: 'persistence_minidb_readmodel',
  title: 'minidb read model',
  description:
    'Use the minidb-backed IQueryStore as a derived read model for session indexing and wire replay.',
  env: 'KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL',
  default: false,
  surface: 'core',
};

registerFlagDefinition(persistenceMiniDbReadModelFlag);
