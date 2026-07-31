/**
 * `subagent` domain (L6) — registers the `secondary-model` experimental flag
 * into `flag`.
 *
 * Gates secondary-model selection for newly spawned subagents, including the
 * agent-facing model choices and startup validation warning. On by default;
 * disable via `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL` or the
 * `[experimental]` config section to restore legacy inherit-the-parent-model
 * behavior. Imported for its side effect from the package barrel.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SECONDARY_MODEL_FLAG_ID = 'secondary-model';
export const SECONDARY_MODEL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL';

export const secondaryModelFlag: FlagDefinitionInput = {
  id: SECONDARY_MODEL_FLAG_ID,
  title: 'Secondary model for subagents',
  description:
    'Let newly spawned subagents use a separately configured secondary model by default, with an explicit per-spawn model override (primary or any configured [models] alias) for quality-sensitive tasks. Enabled by default; disable to restore legacy inherit-the-parent-model behavior.',
  env: SECONDARY_MODEL_FLAG_ENV,
  default: true,
  surface: 'core',
};

registerFlagDefinition(secondaryModelFlag);
