import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

/**
 * `fallback` domain — registers the `fallback-model` experimental flag.
 *
 * Gates the per-provider fallback model cascade: when enabled and
 * `[fallback_model]` is configured, the agent loop transparently retries on
 * the fallback alias after the primary model exhausts its retry budget. When
 * unset, behavior is unchanged (terminal error after the primary budget).
 */
export const FALLBACK_MODEL_FLAG_ID = 'fallback-model';
export const FALLBACK_MODEL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_FALLBACK_MODEL';

export const fallbackModelFlag: FlagDefinitionInput = {
  id: FALLBACK_MODEL_FLAG_ID,
  title: 'Per-provider fallback model cascade',
  description:
    'When the primary model exhausts its retry budget, automatically retry on a configured fallback model and then on a secondary fallback before surfacing a terminal error.',
  env: FALLBACK_MODEL_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(fallbackModelFlag);
