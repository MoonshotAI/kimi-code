/**
 * `subagent` domain (L6) — registers the `secondary-model` experimental flag
 * into `flag`.
 *
 * Gates model selection for newly spawned subagents. When enabled and
 * `[subagent_models]` is populated, the `Agent`/`AgentSwarm` tools expose a
 * choice list (slot names + descriptions) so the parent model can assign
 * subagents to named model slots. Falls back to the legacy
 * `[secondary_model]` section when `[subagent_models]` is empty.
 * Startup validation warnings cover both sections. Off by default;
 * enable via `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL`, the master
 * `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config section.
 * Imported for its side effect from the package barrel.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SECONDARY_MODEL_FLAG_ID = 'secondary-model';
export const SECONDARY_MODEL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL';

export const secondaryModelFlag: FlagDefinitionInput = {
  id: SECONDARY_MODEL_FLAG_ID,
  title: 'Subagent model selection',
  description:
    'Let newly spawned subagents use a configured model slot from [subagent_models] (or [secondary_model]) instead of always inheriting the caller model, with an explicit primary-model override for quality-sensitive tasks.',
  env: SECONDARY_MODEL_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(secondaryModelFlag);
